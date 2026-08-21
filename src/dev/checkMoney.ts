/**
 * Проверка денежной логики на живой базе.
 *
 * Не юнит-тест: половина гарантий здесь — не в коде, а в Postgres (условный
 * UPDATE при списании, уникальный индекс по заказу), и проверять их на
 * заглушках бессмысленно. Скрипт заводит трёх служебных пользователей,
 * гоняет сценарии и убирает за собой.
 *
 *     npm run check:money
 */
import type { Api } from 'grammy';
import { db, sql } from '../db/index.js';
import { users, payments, wallets, walletLedger, referrals, referralCodes, settings } from '../db/schema.js';
import { desc, eq, inArray } from 'drizzle-orm';
import * as W from '../repo/wallet.js';
import * as P from '../repo/payments.js';
import * as Ref from '../repo/referrals.js';
import { getDeckBySlug, ownsDeck, setDeckPrice } from '../repo/decks.js';
import { saveEconomy, getEconomy, invalidateEconomy } from '../repo/settings.js';
import { refundPayment, settle, startDeckPurchase } from '../services/purchase.js';
import { handleInvite } from '../services/referral.js';
import { DEFAULT_ECONOMY } from '../domain/economy.js';

let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const sent: Array<{ chat: number; text: string }> = [];
const fakeApi = {
  sendMessage: (chat: number, text: string) => {
    sent.push({ chat, text });
    return Promise.resolve({});
  },
} as unknown as Api;

const TG = [900000001, 900000002, 900000003];

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.tgId, TG));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  await db.delete(walletLedger).where(inArray(walletLedger.userId, ids));
  await db.delete(wallets).where(inArray(wallets.userId, ids));
  await db.delete(payments).where(inArray(payments.userId, ids));
  await db.delete(referrals).where(inArray(referrals.inviteeId, ids));
  await db.delete(referrals).where(inArray(referrals.referrerId, ids));
  await db.delete(referralCodes).where(inArray(referralCodes.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

async function main(): Promise<void> {
  await cleanup();

  const [alice, bob, carol] = await db
    .insert(users)
    .values(TG.map((tgId, i) => ({ tgId, firstName: ['Алиса', 'Боб', 'Кэрол'][i]! })))
    .returning();

  // ── 1. кошелёк ─────────────────────────────────────────────────────────
  await W.credit({ userId: alice!.id, amount: 100, reason: 'admin_adjust' });
  ok('начисление', (await W.balanceOf(alice!.id)) === 100);

  const over = await W.debit({ userId: alice!.id, amount: 150, reason: 'purchase' });
  ok('списание сверх баланса отклонено', !over.ok && over.balance === 100, over);

  const okDebit = await W.debit({ userId: alice!.id, amount: 40, reason: 'purchase' });
  ok('списание в пределах баланса', okDebit.ok && okDebit.balance === 60, okDebit);

  // Гонка: десять одновременных списаний по 10 при балансе 60 → ровно 6 проходят.
  await W.credit({ userId: bob!.id, amount: 60, reason: 'admin_adjust' });
  const races = await Promise.all(
    Array.from({ length: 10 }, () => W.debit({ userId: bob!.id, amount: 10, reason: 'purchase' })),
  );
  const passed = races.filter((r) => r.ok).length;
  ok('параллельные списания не уводят в минус', passed === 6 && (await W.balanceOf(bob!.id)) === 0, {
    passed,
    balance: await W.balanceOf(bob!.id),
  });

  const ledger = await W.history(bob!.id, 50);
  ok('в журнал попали только прошедшие списания', ledger.filter((l) => l.delta < 0).length === 6);
  ok('balance_after в журнале не отрицательный', ledger.every((l) => l.balanceAfter >= 0));

  // ── 2. идемпотентность оплаты ──────────────────────────────────────────
  const deck = await getDeckBySlug('hardcore');
  if (!deck) throw new Error('нет колоды hardcore');
  // Цены — боевые данные: запоминаем и возвращаем как было, иначе прогон
  // проверки молча переписал бы тариф колоды.
  const priceBackup = { rub: deck.priceRub, stars: deck.priceStars, coins: deck.priceCoins };
  const restorePrices = async (): Promise<void> => {
    await setDeckPrice(deck.id, 'rub', priceBackup.rub);
    await setDeckPrice(deck.id, 'stars', priceBackup.stars);
    await setDeckPrice(deck.id, 'coins', priceBackup.coins);
  };
  await setDeckPrice(deck.id, 'stars', 100);

  const start = await startDeckPurchase({
    userId: carol!.id,
    tgId: carol!.tgId,
    deckId: deck.id,
    provider: 'stars',
  });
  ok('счёт в звёздах выставлен', start.ok && start.checkout.kind === 'stars', start);
  const orderId = start.ok ? start.payment.orderId : '';

  const first = await settle(fakeApi, { orderId, telegramChargeId: 'charge_1' });
  ok('первый вебхук выдал товар', first !== null && (await ownsDeck(carol!.id, deck)));

  const second = await settle(fakeApi, { orderId, telegramChargeId: 'charge_1' });
  ok('повторный вебхук ничего не выдал', second === null);

  const third = await settle(fakeApi, { orderId, telegramChargeId: 'charge_1' });
  ok('третий вебхук тоже молчит', third === null);
  ok('уведомление отправлено ровно один раз', sent.length === 1, sent);

  const grants = await db.select().from(payments).where(eq(payments.orderId, orderId));
  ok('заказ в статусе paid', grants[0]?.status === 'paid');

  const unknown = await settle(fakeApi, { orderId: 'o-не-существует' });
  ok('оплата по неизвестному заказу игнорируется', unknown === null);

  // ── 3. покупка со счёта ────────────────────────────────────────────────
  await setDeckPrice(deck.id, 'coins', 50);
  const poor = await startDeckPurchase({
    userId: alice!.id, tgId: alice!.tgId, deckId: deck.id, provider: 'wallet',
  });
  ok('покупка со счёта при 60 🍌 прошла', poor.ok && (await ownsDeck(alice!.id, deck)), poor);
  ok('со счёта списано 50', (await W.balanceOf(alice!.id)) === 10);

  const again = await startDeckPurchase({
    userId: alice!.id, tgId: alice!.tgId, deckId: deck.id, provider: 'wallet',
  });
  ok('повторная покупка той же колоды отклонена', !again.ok && again.reason === 'owned', again);

  const broke = await startDeckPurchase({
    userId: bob!.id, tgId: bob!.tgId, deckId: deck.id, provider: 'wallet',
  });
  ok('покупка при нулевом счёте отклонена', !broke.ok, broke);
  ok('баланс после неудачи не тронут', (await W.balanceOf(bob!.id)) === 0);

  // ── 3b. возврат ────────────────────────────────────────────────────────
  const walletPay = await db
    .select()
    .from(payments)
    .where(eq(payments.userId, alice!.id))
    .orderBy(desc(payments.id))
    .limit(1);
  const refund = await refundPayment(fakeApi, walletPay[0]!.id);
  ok('возврат прошёл', refund.ok, refund);
  ok('доступ к колоде снят', !(await ownsDeck(alice!.id, deck)));
  ok('🍌 вернулись на счёт', (await W.balanceOf(alice!.id)) === 60);

  const refundTwice = await refundPayment(fakeApi, walletPay[0]!.id);
  ok('повторный возврат отклонён', !refundTwice.ok, refundTwice);

  // ── 3c. смена цены отменяет незакрытый заказ ───────────────────────────
  await setDeckPrice(deck.id, 'stars', 100);
  const firstOrder = await startDeckPurchase({
    userId: bob!.id, tgId: bob!.tgId, deckId: deck.id, provider: 'stars',
  });
  await setDeckPrice(deck.id, 'stars', 250);
  const afterPriceChange = await startDeckPurchase({
    userId: bob!.id, tgId: bob!.tgId, deckId: deck.id, provider: 'stars',
  });
  ok(
    'после смены цены выставляется новый заказ',
    firstOrder.ok && afterPriceChange.ok && firstOrder.payment.orderId !== afterPriceChange.payment.orderId,
  );
  ok(
    'новый заказ на новую цену',
    afterPriceChange.ok && afterPriceChange.payment.amountMinor === 250,
    afterPriceChange.ok ? afterPriceChange.payment.amountMinor : null,
  );
  const staleOrder = firstOrder.ok ? await P.byOrderId(firstOrder.payment.orderId) : undefined;
  ok('старый заказ закрыт', staleOrder?.status === 'canceled', staleOrder?.status);

  // Тот же заказ при неизменной цене — переиспользуется, а не плодится.
  const sameAgain = await startDeckPurchase({
    userId: bob!.id, tgId: bob!.tgId, deckId: deck.id, provider: 'stars',
  });
  ok(
    'при неизменной цене заказ переиспользуется',
    sameAgain.ok && afterPriceChange.ok && sameAgain.payment.orderId === afterPriceChange.payment.orderId,
  );

  // ── 4. рефералы ────────────────────────────────────────────────────────
  const code = await Ref.ensureCode(alice!.id);
  ok('код выдан', /^[A-Z0-9]{8}$/.test(code), code);
  ok('код стабилен', (await Ref.ensureCode(alice!.id)) === code);

  const self = await handleInvite(alice!.id, code);
  ok('сам себя пригласить нельзя', !self.attached);

  const attached = await handleInvite(bob!.id, code);
  ok('приглашение записано', attached.attached);

  const twice = await handleInvite(bob!.id, code);
  ok('повторная привязка отклонена', !twice.attached);

  const carolCode = await Ref.ensureCode(carol!.id);
  const steal = await handleInvite(bob!.id, carolCode);
  ok('перехватить чужого реферала нельзя', !steal.attached);

  const bad = await handleInvite(carol!.id, 'ZZZZZZZZ');
  ok('неизвестный код отклонён', !bad.attached);

  const stats = await Ref.statsOf(alice!.id);
  ok('счётчик приглашённых', stats.invited === 1, stats);

  // ── 5. настройки экономики ─────────────────────────────────────────────
  await saveEconomy({ ...DEFAULT_ECONOMY, referral: { ...DEFAULT_ECONOMY.referral, inviterBonus: 777 } }, alice!.id);
  invalidateEconomy();
  const econ = await getEconomy();
  ok('настройка сохранена', econ.referral.inviterBonus === 777, econ.referral);
  ok('недостающие поля добираются из умолчаний', econ.rates.coinsPerRub === DEFAULT_ECONOMY.rates.coinsPerRub);

  // Снимок старой версии без новых полей — merge не должен уронить магазин.
  await db.update(settings).set({ value: { referral: { enabled: true } } }).where(eq(settings.key, 'economy'));
  invalidateEconomy();
  const partial = await getEconomy();
  ok('частичный снимок настроек не ломает чтение', partial.providers.stars === true && partial.referral.enabled === true, partial);

  await db.delete(settings).where(eq(settings.key, 'economy'));
  await restorePrices();
  await cleanup();
  const restored = await getDeckBySlug('hardcore');
  ok(
    'цены колоды восстановлены',
    restored?.priceRub === priceBackup.rub &&
      restored?.priceStars === priceBackup.stars &&
      restored?.priceCoins === priceBackup.coins,
    restored,
  );
  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки прошли');
  await sql.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await sql.end();
  process.exit(1);
});
