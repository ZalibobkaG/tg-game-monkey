import { randomUUID } from 'node:crypto';
import type { Api } from 'grammy';
import { getDeck, grantDeck, ownsDeck, revokeDeck } from '../repo/decks.js';
import type { Deck } from '../repo/decks.js';
import { getUserById } from '../repo/users.js';
import { refund as yookassaRefund } from '../payments/yookassa.js';
import * as P from '../repo/payments.js';
import type { Payment, PaymentProvider } from '../repo/payments.js';
import * as W from '../repo/wallet.js';
import * as Ref from '../repo/referrals.js';
import { getEconomy } from '../repo/settings.js';
import { adapter } from '../payments/index.js';
import type { Checkout } from '../payments/index.js';
import { COIN, coins, referralCut, rubles } from '../domain/economy.js';
import { esc } from '../ui/lobby.js';
import { track } from './analytics.js';
import { log, payLog } from '../lib/log.js';

/**
 * Покупки: оформление заказа и — главное — выдача товара.
 *
 * Выдача живёт в одном месте намеренно. Звёзды приходят апдейтом от Telegram,
 * ЮKassa и крипта — вебхуками, кошелёк списывается прямо здесь; путей много,
 * но точка, где начисляется доступ, должна быть одна, иначе идемпотентность
 * придётся доказывать для каждой пары «провайдер × товар».
 */

/** Заказ, начатый и брошенный меньше часа назад, переиспользуем. */
const PENDING_TTL_MS = 60 * 60 * 1000;

/**
 * Идентификатор заказа. Уходит в invoice payload (Bot API даёт на него
 * 128 байт) и в metadata кассы, поэтому — компактный и без разделителей,
 * которые пришлось бы экранировать.
 */
const newOrderId = (): string => `o${randomUUID().replace(/-/g, '')}`;

export type StartResult =
  | { ok: true; checkout: Checkout; payment: Payment }
  | { ok: false; reason: 'owned' | 'unavailable' | 'no_price' | 'insufficient' | 'provider_error'; message: string };

/** Цена колоды в валюте выбранной кассы, в минорных единицах. */
function priceFor(deck: Deck, provider: PaymentProvider): number {
  if (provider === 'stars') return deck.priceStars;
  if (provider === 'wallet') return deck.priceCoins;
  return deck.priceRub * 100;
}

/**
 * Оформить покупку колоды. Возвращает то, что нужно показать человеку:
 * нативный счёт в звёздах или ссылку на внешнюю кассу.
 */
export async function startDeckPurchase(args: {
  userId: number;
  tgId: number;
  deckId: number;
  provider: PaymentProvider;
}): Promise<StartResult> {
  const deck = await getDeck(args.deckId);
  if (!deck || !deck.isPremium) {
    return { ok: false, reason: 'unavailable', message: 'Такой колоды нет в продаже.' };
  }
  if (!deck.active) {
    return { ok: false, reason: 'unavailable', message: 'Колода снята с продажи.' };
  }
  if (await ownsDeck(args.userId, deck)) {
    return { ok: false, reason: 'owned', message: 'Эта колода у тебя уже есть.' };
  }

  const amountMinor = priceFor(deck, args.provider);
  if (amountMinor <= 0) {
    return { ok: false, reason: 'no_price', message: 'Для этого способа оплаты цена не назначена.' };
  }

  if (args.provider === 'wallet') return payDeckWithWallet(args.userId, deck);

  const ad = adapter(args.provider);
  if (!ad || !ad.configured()) {
    return { ok: false, reason: 'unavailable', message: 'Этот способ оплаты сейчас недоступен.' };
  }

  // Незакрытый заказ переиспользуем: два счёта на одну колоду — верный
  // способ получить две оплаты и один товар. Но только если цена с тех пор
  // не изменилась: иначе на pre_checkout суммы не сойдутся и Telegram
  // отклонит оплату, которую человек уже начал.
  const found = await P.pendingOrder(args.userId, args.provider, deck.id, PENDING_TTL_MS);
  const existing = found?.amountMinor === amountMinor ? found : undefined;
  if (found && !existing) {
    await P.markFailed(found.orderId, 'canceled', { reason: 'price_changed' });
  }
  if (existing?.payUrl) {
    return { ok: true, checkout: { kind: 'url', url: existing.payUrl }, payment: existing };
  }

  const payment =
    existing ??
    (await P.createOrder({
      userId: args.userId,
      kind: 'deck',
      deckId: deck.id,
      provider: args.provider,
      orderId: newOrderId(),
      amountMinor,
      currency: ad.currency,
      // Рублёвый эквивалент фиксируем на момент заказа: по нему потом
      // считается реферальный процент, чем бы человек ни расплатился.
      metadata: { rubValue: deck.priceRub, deckSlug: deck.slug },
    }));

  payLog.info(
    {
      step: 'order_created',
      orderId: payment.orderId,
      userId: args.userId,
      provider: args.provider,
      deck: deck.slug,
      amountMinor,
      currency: ad.currency,
      reused: Boolean(existing),
    },
    `заказ на «${deck.title}»`,
  );

  try {
    const checkout = await ad.createCheckout({
      orderId: payment.orderId,
      title: deck.title,
      description: deck.description || `Колода «${deck.title}» для игры «Обезьянка»`,
      amountMinor,
      tgId: args.tgId,
    });

    if (checkout.kind === 'url') {
      await P.setPayUrl(payment.id, checkout.url, checkout.externalId);
    }
    payLog.info(
      {
        step: 'checkout_ready',
        orderId: payment.orderId,
        provider: args.provider,
        kind: checkout.kind,
        externalId: checkout.kind === 'url' ? checkout.externalId : null,
        payUrl: checkout.kind === 'url' ? checkout.url : null,
      },
      'счёт выставлен',
    );
    track({
      type: 'purchase_started',
      userId: args.userId,
      payload: { provider: args.provider, deckSlug: deck.slug, amountMinor },
    });
    return { ok: true, checkout, payment };
  } catch (e) {
    payLog.error({ step: 'checkout_failed', err: e, provider: args.provider, orderId: payment.orderId }, 'не смог выставить счёт');
    await P.markFailed(payment.orderId, 'failed', { error: String(e) });
    return { ok: false, reason: 'provider_error', message: 'Касса не ответила. Попробуй ещё раз или выбери другой способ.' };
  }
}

/**
 * Оплата колоды с личного счёта. Проводится сразу и целиком: списание
 * и выдача — в одном вызове, потому что внешних сторон здесь нет.
 */
async function payDeckWithWallet(userId: number, deck: Deck): Promise<StartResult> {
  const payment = await P.createOrder({
    userId,
    kind: 'deck',
    deckId: deck.id,
    provider: 'wallet',
    orderId: newOrderId(),
    amountMinor: deck.priceCoins,
    currency: 'COIN',
    metadata: { rubValue: deck.priceRub, deckSlug: deck.slug },
  });

  const spent = await W.debit({
    userId,
    amount: deck.priceCoins,
    reason: 'purchase',
    refId: payment.id,
    comment: deck.title,
  });

  if (!spent.ok) {
    payLog.info(
      { step: 'wallet_declined', orderId: payment.orderId, userId, need: deck.priceCoins, have: spent.balance },
      'на счету не хватает 🍌',
    );
    await P.markFailed(payment.orderId, 'canceled', { reason: 'insufficient_funds' });
    return {
      ok: false,
      reason: 'insufficient',
      message: `Не хватает ${COIN}. На счету ${coins(spent.balance)}, нужно ${coins(deck.priceCoins)}.`,
    };
  }

  payLog.info(
    { step: 'wallet_charged', orderId: payment.orderId, userId, spent: deck.priceCoins, balance: spent.balance },
    'списано со счёта',
  );

  const settled = await P.markPaid({ orderId: payment.orderId });
  if (settled.ok) await deliver(settled.payment);
  return { ok: true, checkout: { kind: 'settled' }, payment };
}

/**
 * Выдать оплаченное. Вызывается ровно один раз на заказ — гарантию даёт
 * условный UPDATE в `markPaid`, а не проверка здесь.
 */
async function deliver(payment: Payment): Promise<void> {
  payLog.info(
    {
      step: 'deliver',
      orderId: payment.orderId,
      paymentId: payment.id,
      userId: payment.userId,
      kind: payment.kind,
      deckId: payment.deckId,
      coins: payment.coinsAmount,
    },
    'выдаю оплаченное',
  );

  if (payment.kind === 'deck' && payment.deckId) {
    await grantDeck(payment.userId, payment.deckId, payment.id);
  } else if (payment.kind === 'topup' && payment.coinsAmount > 0) {
    await W.credit({
      userId: payment.userId,
      amount: payment.coinsAmount,
      reason: 'topup',
      refId: payment.id,
      comment: `Пополнение через ${payment.provider}`,
    });
  }

  track({
    type: 'purchase_paid',
    userId: payment.userId,
    payload: {
      provider: payment.provider,
      kind: payment.kind,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    },
  });

  await payReferralCut(payment).catch((e) =>
    log.error({ err: e, paymentId: payment.id }, 'реферальное начисление не прошло'),
  );
}

/**
 * Процент пригласившему. Ошибка здесь не должна отменять покупку — товар
 * уже выдан, а бонус можно доначислить руками, поэтому вызывающий ловит
 * исключение и только пишет в лог.
 */
async function payReferralCut(payment: Payment): Promise<void> {
  const e = await getEconomy();
  if (!e.referral.enabled) return;

  const link = await Ref.referrerOf(payment.userId);
  if (!link) return;

  const rubValue = Number(payment.metadata['rubValue'] ?? 0);
  let bonus = referralCut(e, rubValue);

  // Первая покупка приглашённого — разовый бонус пригласившему сверху.
  const firstPurchase = await Ref.markSignupRewarded(payment.userId);
  if (firstPurchase) bonus += e.referral.inviterBonus;

  if (e.referral.perReferralCap > 0) {
    bonus = Math.min(bonus, Math.max(0, e.referral.perReferralCap - link.earned));
  }
  if (bonus <= 0) return;

  await W.credit({
    userId: link.referrerId,
    amount: bonus,
    reason: 'referral_bonus',
    refId: payment.userId,
    comment: 'С покупки приглашённого',
  });
  await Ref.addEarned(payment.userId, bonus);
  payLog.info(
    { step: 'referral_bonus', orderId: payment.orderId, referrerId: link.referrerId, inviteeId: payment.userId, bonus, firstPurchase },
    'начислил пригласившему',
  );
  track({
    type: 'referral_bonus',
    userId: link.referrerId,
    payload: { inviteeId: payment.userId, bonus, paymentId: payment.id },
  });
}

/**
 * Провести оплату, пришедшую снаружи: звёздный `successful_payment` или
 * вебхук кассы. Идемпотентна — повторный вызов с тем же orderId ничего
 * не выдаст и никого не уведомит.
 */
export async function settle(
  api: Api,
  args: {
    orderId: string;
    externalId?: string | null;
    telegramChargeId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<Payment | null> {
  const res = await P.markPaid(args);
  if (!res.ok) {
    if (res.reason === 'not_found') {
      payLog.warn({ step: 'settle_unknown', orderId: args.orderId }, 'оплата по неизвестному заказу');
    } else {
      payLog.info(
        { step: 'settle_duplicate', orderId: args.orderId, status: res.payment?.status },
        'повторное уведомление об оплате — пропускаю',
      );
    }
    return null;
  }

  const payment = res.payment;
  payLog.info(
    {
      step: 'settled',
      orderId: payment.orderId,
      paymentId: payment.id,
      userId: payment.userId,
      provider: payment.provider,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      externalId: args.externalId ?? null,
    },
    'оплата проведена',
  );
  await deliver(payment);
  await notifyPaid(api, payment).catch((e) =>
    log.error({ err: e, paymentId: payment.id }, 'не смог сообщить об оплате'),
  );
  return payment;
}

async function notifyPaid(api: Api, payment: Payment): Promise<void> {
  const user = await getUserById(payment.userId);
  if (!user) return;

  const lines =
    payment.kind === 'topup'
      ? [
          '✅ <b>Счёт пополнен</b>',
          '',
          `Зачислено: <b>${coins(payment.coinsAmount)}</b> ${COIN}`,
          `Баланс: <b>${coins(await W.balanceOf(payment.userId))}</b>`,
        ]
      : [
          '✅ <b>Колода куплена</b>',
          '',
          `«${esc((await getDeck(payment.deckId ?? 0))?.title ?? 'Колода')}» открыта — выбирай её в лобби.`,
        ];

  await api.sendMessage(user.tgId, lines.join('\n'), { parse_mode: 'HTML' });
}

/** Пополнение счёта: покупают не колоду, а 🍌. */
export async function startTopup(args: {
  userId: number;
  tgId: number;
  provider: PaymentProvider;
  /** сколько 🍌 хочет получить */
  coinsAmount: number;
}): Promise<StartResult> {
  const e = await getEconomy();
  const ad = adapter(args.provider);
  if (!ad || !ad.configured()) {
    return { ok: false, reason: 'unavailable', message: 'Этот способ оплаты сейчас недоступен.' };
  }

  const rate = args.provider === 'stars' ? e.rates.coinsPerStar : e.rates.coinsPerRub;
  if (rate <= 0) return { ok: false, reason: 'no_price', message: 'Курс пополнения не задан.' };

  // Считаем от 🍌 к деньгам и округляем вверх: недобор здесь означал бы,
  // что человек получает больше, чем оплатил.
  const units = Math.ceil(args.coinsAmount / rate);
  const amountMinor = args.provider === 'stars' ? units : units * 100;
  const rubValue = args.provider === 'stars' ? 0 : units;

  const payment = await P.createOrder({
    userId: args.userId,
    kind: 'topup',
    provider: args.provider,
    orderId: newOrderId(),
    amountMinor,
    currency: ad.currency,
    coinsAmount: args.coinsAmount,
    metadata: { rubValue },
  });

  try {
    const checkout = await ad.createCheckout({
      orderId: payment.orderId,
      title: `${args.coinsAmount} ${COIN}`,
      description: `Пополнение счёта в боте «Обезьянка» на ${coins(args.coinsAmount)}`,
      amountMinor,
      tgId: args.tgId,
    });
    if (checkout.kind === 'url') await P.setPayUrl(payment.id, checkout.url, checkout.externalId);
    payLog.info(
      { step: 'topup_ready', orderId: payment.orderId, userId: args.userId, provider: args.provider, coins: args.coinsAmount, amountMinor },
      'счёт на пополнение выставлен',
    );
    track({ type: 'purchase_started', userId: args.userId, payload: { provider: args.provider, kind: 'topup' } });
    return { ok: true, checkout, payment };
  } catch (err) {
    payLog.error({ step: 'topup_failed', err, orderId: payment.orderId }, 'не смог выставить счёт на пополнение');
    await P.markFailed(payment.orderId, 'failed', { error: String(err) });
    return { ok: false, reason: 'provider_error', message: 'Касса не ответила. Попробуй ещё раз.' };
  }
}

/**
 * Возврат. Звёзды возвращает Telegram по `telegram_payment_charge_id`,
 * рубли — касса; в обоих случаях сначала снимаем товар, потом просим
 * деньги обратно, иначе при сбое останется и то и другое.
 */
export async function refundPayment(
  api: Api,
  paymentId: number,
): Promise<{ ok: boolean; message: string }> {
  const payment = await P.byId(paymentId);
  if (!payment) return { ok: false, message: 'Платёж не найден.' };
  if (payment.status !== 'paid') return { ok: false, message: `Платёж в статусе «${payment.status}» — возвращать нечего.` };

  payLog.warn(
    { step: 'refund_start', paymentId: payment.id, orderId: payment.orderId, provider: payment.provider, amountMinor: payment.amountMinor },
    'начинаю возврат',
  );

  const marked = await P.markRefunded(payment.id);
  if (!marked) return { ok: false, message: 'Возврат уже проводится.' };

  try {
    if (payment.provider === 'stars') {
      if (!payment.telegramChargeId) throw new Error('нет telegram_payment_charge_id');
      const user = await getUserById(payment.userId);
      if (!user) throw new Error('пользователь не найден');
      await api.refundStarPayment(user.tgId, payment.telegramChargeId);
    } else if (payment.provider === 'yookassa') {
      if (!payment.externalId) throw new Error('нет id платежа в кассе');
      await yookassaRefund(payment.externalId, payment.amountMinor);
    } else if (payment.provider === 'wallet') {
      await W.credit({
        userId: payment.userId,
        amount: payment.amountMinor,
        reason: 'refund',
        refId: payment.id,
        comment: 'Возврат за колоду',
      });
    } else if (payment.provider !== 'cryptobot' && payment.provider !== 'manual') {
      throw new Error(`возврат для провайдера ${payment.provider} не реализован`);
    }
  } catch (e) {
    payLog.error({ step: 'refund_failed', err: e, paymentId, orderId: payment.orderId }, 'возврат не прошёл');
    return { ok: false, message: `Возврат не прошёл: ${String(e)}. Заказ помечен возвращённым — верни деньги вручную.` };
  }

  // Доступ снимаем после того, как деньги ушли обратно: наоборот было бы
  // хуже — человек остался бы и без колоды, и без денег.
  if (payment.kind === 'deck' && payment.deckId) {
    await revokeDeck(payment.userId, payment.deckId);
  }
  payLog.warn({ step: 'refund_done', paymentId: payment.id, orderId: payment.orderId }, 'возврат проведён');

  // Crypto Pay не умеет возвращать платёж по API — деньги отправляет владелец
  // руками, поэтому честно говорим об этом, а не рапортуем об успехе.
  if (payment.provider === 'cryptobot') {
    return { ok: true, message: 'Доступ снят. Крипту верни вручную через @CryptoBot.' };
  }
  return {
    ok: true,
    message: `Вернул ${payment.currency === 'RUB' ? `${rubles(payment.amountMinor)} ₽` : `${payment.amountMinor} ${payment.currency}`}. Доступ снят.`,
  };
}
