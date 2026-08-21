/**
 * Проверка защищённости: SQL-инъекции, разметка в сообщениях, доступ
 * к вебхукам, обход оплаты.
 *
 * Бьём по настоящим функциям настоящими полезными нагрузками — читать код
 * глазами и убеждать себя, что drizzle «наверное, параметризует», мало.
 *
 *     npm run check:security
 */
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from 'grammy';
import { db, sql as pg } from '../db/index.js';
import { users, referralCodes, payments, wallets, walletLedger, referrals } from '../db/schema.js';
import { count, eq, inArray } from 'drizzle-orm';
import * as S from '../repo/stats.js';
import * as W from '../repo/wallet.js';
import * as Ref from '../repo/referrals.js';
import { getDeckBySlug, setDeckPrice } from '../repo/decks.js';
import { settle, startDeckPurchase } from '../services/purchase.js';
import { handlePaymentWebhook } from '../http/webhooks.js';
import { verifySignature } from '../payments/cryptobot.js';
import { renderUserCard } from '../ui/admin.js';
import { renderPlayerStats } from '../ui/admin.js';

let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const fakeApi = { sendMessage: () => Promise.resolve({}) } as unknown as Api;
const TG = [910000001, 910000002];

/** Классические полезные нагрузки для SQL-инъекции. */
const SQLI = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  "1; DELETE FROM payments WHERE 1=1; --",
  "%' OR 1=1 --",
  "\\'; select pg_sleep(5); --",
  "' UNION SELECT null,null,null --",
];

/** Полезные нагрузки для разметки Telegram: parse_mode=HTML. */
const HTMLI = [
  '<b>жирный</b>',
  '<a href="http://evil.example">клик</a>',
  '</b><script>alert(1)</script>',
  '<code>&lt;</code>&amp;',
];

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

/** Поддельный HTTP-запрос — чтобы бить по роутеру вебхуков без сети. */
function fakeReq(url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  req.url = url;
  req.method = 'POST';
  req.headers = headers;
  return req;
}

function fakeRes(): { res: ServerResponse; status: () => number | null } {
  let code: number | null = null;
  const res = {
    writeHead(c: number) {
      code = c;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => code };
}

async function main(): Promise<void> {
  await cleanup();
  const usersBefore = (await db.select({ n: count() }).from(users))[0]!.n;

  const [victim, attacker] = await db
    .insert(users)
    .values([
      { tgId: TG[0]!, firstName: 'Жертва' },
      // Имя целиком под контролем атакующего — Telegram его не фильтрует.
      { tgId: TG[1]!, firstName: '<b>Админ</b> <a href="http://evil.example">тык</a>', username: 'evil<script>' },
    ])
    .returning();

  // ── 1. SQL-инъекции через реальные пути ────────────────────────────────
  for (const payload of SQLI) {
    try {
      await S.findUsers(payload, 10);
      await Ref.userIdByCode(payload);
      await settle(fakeApi, { orderId: payload });
      ok(`инъекция отбита: ${payload.slice(0, 28)}`, true);
    } catch (e) {
      ok(`инъекция отбита: ${payload.slice(0, 28)}`, false, String(e));
    }
  }

  const usersAfter = (await db.select({ n: count() }).from(users))[0]!.n;
  ok('таблица users на месте и не обрезана', usersAfter === usersBefore + 2, { usersBefore, usersAfter });

  // Инъекция в LIKE-шаблон не должна возвращать чужие строки.
  const wildcard = await S.findUsers("%' OR 1=1 --", 50);
  ok('подстановка в LIKE не выдаёт всех подряд', wildcard.length === 0, wildcard.length);

  // ── 2. Разметка в сообщениях ───────────────────────────────────────────
  const card = await S.userCard(attacker!.id);
  const rendered = renderUserCard({
    card: card!,
    decks: [],
    role: null,
    canModerate: true,
    balance: 0,
    spent: 0,
    invited: 0,
    referrerName: '<i>подделка</i>',
  });

  ok(
    'имя игрока в карточке экранировано',
    rendered.text.includes('&lt;b&gt;Админ&lt;/b&gt;') && !rendered.text.includes('<b>Админ</b>'),
    rendered.text.slice(0, 160),
  );
  ok(
    'ссылка из имени не превращается в разметку',
    !rendered.text.includes('<a href='),
    rendered.text.slice(0, 200),
  );
  ok('имя пригласившего экранировано', rendered.text.includes('&lt;i&gt;подделка&lt;/i&gt;'));

  for (const payload of HTMLI) {
    const stats = renderPlayerStats({
      name: payload,
      gamesPlayed: 1, gamesAsMonkey: 0, winsAsMonkey: 0,
      winsAsPeasant: 0, votesCast: 0, correctVotes: 0, referrals: 0,
    });
    // В выводе не должно остаться ни одного «живого» тега из полезной нагрузки.
    const leaked = /<(b|a|script|code)\b/i.test(stats.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
    ok(`разметка в имени обезврежена: ${payload.slice(0, 26)}`, !leaked, stats);
  }

  // ── 3. Вебхуки ─────────────────────────────────────────────────────────
  const { res: r2 } = fakeRes();
  const notOurs = await handlePaymentWebhook(fakeApi, fakeReq('/health', '', {}), r2);
  ok('вебхук не перехватывает посторонние пути', !notOurs);

  const { res: r3, status: s3 } = fakeRes();
  await handlePaymentWebhook(fakeApi, fakeReq('/pay/../admin/x', '{}'), r3);
  ok('выход из каталога отвергнут', s3() === 404, s3());

  ok('подпись Crypto Pay без заголовка не проходит', !verifySignature('{}', ''));
  ok('подпись Crypto Pay подобранная не проходит', !verifySignature('{}', 'a'.repeat(64)));

  // Остальное — в отдельном процессе с подставными ключами: в этом секреты
  // читаются из .env, где они пустые, и роутер отвергал бы вообще всё —
  // проверка «неверный секрет не проходит» оказалась бы бессодержательной.
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(new URL('./checkWebhookAuth.ts', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WEBHOOK_PATH_SECRET: 'test' + 'a1b2c3d4'.repeat(4),
        CRYPTO_PAY_TOKEN: '12345:TEST-TOKEN-FOR-SIGNATURE-CHECK',
        YOOKASSA_SHOP_ID: '000000',
        YOOKASSA_SECRET_KEY: 'test_key',
      },
    },
  );
  process.stdout.write(child.stdout ?? '');
  if (child.status !== 0) {
    failed++;
    process.stderr.write(child.stderr ?? '');
  }

  // ── 4. Обход оплаты ────────────────────────────────────────────────────
  const deck = await getDeckBySlug('hardcore');
  const backup = { rub: deck!.priceRub, stars: deck!.priceStars, coins: deck!.priceCoins };

  ok('выдача по несуществующему заказу не проходит', (await settle(fakeApi, { orderId: 'o' + 'f'.repeat(32) })) === null);

  await setDeckPrice(deck!.id, 'coins', 100);
  const noMoney = await startDeckPurchase({
    userId: victim!.id, tgId: victim!.tgId, deckId: deck!.id, provider: 'wallet',
  });
  ok('покупка без денег отклонена', !noMoney.ok && noMoney.reason === 'insufficient', noMoney);

  // Отрицательные суммы не должны создавать деньги из воздуха.
  let negRejected = false;
  try {
    await W.credit({ userId: victim!.id, amount: -1000, reason: 'admin_adjust' });
  } catch {
    negRejected = true;
  }
  ok('отрицательное начисление отклонено', negRejected && (await W.balanceOf(victim!.id)) === 0);

  let negDebit = false;
  try {
    await W.debit({ userId: victim!.id, amount: -1000, reason: 'purchase' });
  } catch {
    negDebit = true;
  }
  ok('отрицательное списание отклонено', negDebit && (await W.balanceOf(victim!.id)) === 0);

  // Цена клампится в неотрицательную — отрицательный тариф означал бы
  // «купи колоду и получи денег».
  await setDeckPrice(deck!.id, 'coins', -500);
  const after = await getDeckBySlug('hardcore');
  ok('отрицательная цена не сохраняется', after!.priceCoins === 0, after!.priceCoins);

  // ── 5. Самонакрутка рефералов ──────────────────────────────────────────
  const code = await Ref.ensureCode(attacker!.id);
  const selfRef = await Ref.attach(attacker!.id, code, { maxAgeMs: 60_000 });
  ok('самоприглашение отклонено', !selfRef.ok && selfRef.reason === 'self', selfRef);

  const stale = await Ref.attach(victim!.id, code, { maxAgeMs: 0 });
  ok('старого пользователя в рефералы не записать', !stale.ok && stale.reason === 'not_new', stale);

  await setDeckPrice(deck!.id, 'rub', backup.rub);
  await setDeckPrice(deck!.id, 'stars', backup.stars);
  await setDeckPrice(deck!.id, 'coins', backup.coins);
  await cleanup();

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки прошли');
  await pg.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await pg.end();
  process.exit(1);
});
