import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types.js';
import { deckActions, decksFor, getDeck } from '../repo/decks.js';
import * as W from '../repo/wallet.js';
import * as P from '../repo/payments.js';
import type { PaymentProvider } from '../repo/payments.js';
import { getEconomy } from '../repo/settings.js';
import { availableProviders } from '../payments/index.js';
import { settle, startDeckPurchase, startTopup } from '../services/purchase.js';
import { inviteCard } from '../services/referral.js';
import * as UI from '../ui/shop.js';
import { esc } from '../ui/lobby.js';
import { COIN, coins } from '../domain/economy.js';
import { STARS_CURRENCY } from '../payments/stars.js';
import { trackShopOpened } from '../services/analytics.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { payLog } from '../lib/log.js';

export const shopHandler = new Composer<BotContext>();

/** Оформление счёта ходит во внешнюю кассу — на кнопку «купить» ставим ограничитель. */
const buyLimiter = createRateLimiter(10, 60_000);

/** Сколько 🍌 предлагаем докупить одним нажатием. */
const TOPUP_OPTIONS = [100, 300, 1000];

// ─── витрина ──────────────────────────────────────────────────────────────

async function showShop(ctx: BotContext, edit: boolean): Promise<void> {
  const [decks, economy, wallet] = await Promise.all([
    decksFor(ctx.user.id),
    getEconomy(),
    W.getWallet(ctx.user.id),
  ]);

  const { text, keyboard } = UI.renderShop({
    decks,
    providers: availableProviders(economy),
    walletOn: economy.providers.wallet,
    balance: wallet.balance,
  });

  const opts = { parse_mode: 'HTML', reply_markup: keyboard } as const;
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

shopHandler.command('shop', async (ctx) => {
  trackShopOpened(ctx.user.id, 'command');
  await showShop(ctx, false);
});

shopHandler.callbackQuery('shop:home', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showShop(ctx, true);
});

shopHandler.callbackQuery('menu:shop', async (ctx) => {
  await ctx.answerCallbackQuery();
  trackShopOpened(ctx.user.id, 'menu');
  await showShop(ctx, false);
});

shopHandler.callbackQuery('shop:close', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

shopHandler.callbackQuery(/^shop:deck:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const deckId = Number(ctx.match![1]);

  const [decks, economy, wallet] = await Promise.all([
    decksFor(ctx.user.id),
    getEconomy(),
    W.getWallet(ctx.user.id),
  ]);
  const deck = decks.find((d) => d.id === deckId);
  if (!deck) {
    await ctx.reply('Колода не найдена.');
    return;
  }

  const { text, keyboard } = UI.renderDeckOffer({
    deck,
    providers: availableProviders(economy),
    walletOn: economy.providers.wallet,
    balance: wallet.balance,
    actionsCount: (await deckActions(deck.id)).length,
  });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── покупка ──────────────────────────────────────────────────────────────

shopHandler.callbackQuery(/^shop:buy:(\d+):(stars|yookassa|cryptobot|wallet)$/, async (ctx) => {
  if (!buyLimiter.take(ctx.user.tgId)) {
    await ctx.answerCallbackQuery({ text: '⏳ Слишком часто. Подожди минуту.', show_alert: true });
    return;
  }

  const deckId = Number(ctx.match![1]);
  const provider = ctx.match![2] as PaymentProvider;

  // Способ оплаты приходит с кнопки — проверяем, что он и правда включён:
  // старое сообщение с кнопками живёт в чате вечно, а настройки меняются.
  const economy = await getEconomy();
  const allowed =
    provider === 'wallet'
      ? economy.providers.wallet
      : availableProviders(economy).some((p) => p.id === provider);
  if (!allowed) {
    await ctx.answerCallbackQuery({ text: 'Этот способ оплаты больше недоступен.', show_alert: true });
    await showShop(ctx, true);
    return;
  }

  await ctx.answerCallbackQuery();

  const res = await startDeckPurchase({
    userId: ctx.user.id,
    tgId: ctx.user.tgId,
    deckId,
    provider,
  });

  if (!res.ok) {
    await ctx.reply(`⚠️ ${res.message}`);
    return;
  }

  const deck = await getDeck(deckId);
  if (!deck) return;

  if (res.checkout.kind === 'stars') {
    // provider_token для звёзд пустой, prices — ровно один элемент.
    await ctx.replyWithInvoice(
      res.checkout.title,
      res.checkout.description,
      res.checkout.payload,
      STARS_CURRENCY,
      [{ label: res.checkout.title, amount: res.checkout.amount }],
      { provider_token: '' },
    );
    return;
  }

  if (res.checkout.kind === 'url') {
    await ctx.reply(
      [
        `🧾 <b>${esc(deck.title)}</b>`,
        '',
        `К оплате: <b>${deck.priceRub} ₽</b>`,
        '',
        'Нажми кнопку — откроется страница оплаты.',
        'Как только платёж пройдёт, колода откроется сама.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .url('💳 Оплатить', res.checkout.url)
          .row()
          .text('← В магазин', 'shop:home'),
      },
    );
    return;
  }

  // kind === 'settled' — оплата со счёта прошла прямо сейчас
  const { text, keyboard } = UI.renderPurchased(deck, await W.balanceOf(ctx.user.id));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });
});

// ─── счёт ─────────────────────────────────────────────────────────────────

async function showWallet(ctx: BotContext, edit: boolean): Promise<void> {
  const [wallet, history, economy] = await Promise.all([
    W.getWallet(ctx.user.id),
    W.history(ctx.user.id, 10),
    getEconomy(),
  ]);

  const { text, keyboard } = UI.renderWallet({
    balance: wallet.balance,
    totalEarned: wallet.totalEarned,
    totalSpent: wallet.totalSpent,
    history,
    topupOptions: TOPUP_OPTIONS,
    canTopup: availableProviders(economy).length > 0,
  });

  const opts = { parse_mode: 'HTML', reply_markup: keyboard } as const;
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

shopHandler.command('balance', (ctx) => showWallet(ctx, false));

shopHandler.callbackQuery('shop:wallet', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showWallet(ctx, true);
});

/** Выбор кассы для пополнения. Один доступный способ — не спрашиваем. */
shopHandler.callbackQuery(/^shop:topup:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const amount = Number(ctx.match![1]);
  const providers = availableProviders(await getEconomy());

  if (!providers.length) {
    await ctx.reply('Пополнение сейчас недоступно.');
    return;
  }
  if (providers.length === 1) return topup(ctx, amount, providers[0]!.id);

  const keyboard = new InlineKeyboard();
  for (const p of providers) keyboard.text(p.title, `shop:topupvia:${amount}:${p.id}`).row();
  keyboard.text('← Назад', 'shop:wallet');
  await ctx.reply(`Пополнить на <b>${coins(amount)}</b> ${COIN}. Чем платишь?`, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

shopHandler.callbackQuery(/^shop:topupvia:(\d+):(stars|yookassa|cryptobot)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await topup(ctx, Number(ctx.match![1]), ctx.match![2] as PaymentProvider);
});

async function topup(ctx: BotContext, amount: number, provider: PaymentProvider): Promise<void> {
  if (!buyLimiter.take(ctx.user.tgId)) {
    await ctx.reply('⏳ Слишком часто. Подожди минуту.');
    return;
  }

  const res = await startTopup({ userId: ctx.user.id, tgId: ctx.user.tgId, provider, coinsAmount: amount });
  if (!res.ok) {
    await ctx.reply(`⚠️ ${res.message}`);
    return;
  }

  if (res.checkout.kind === 'stars') {
    await ctx.replyWithInvoice(
      res.checkout.title,
      res.checkout.description,
      res.checkout.payload,
      STARS_CURRENCY,
      [{ label: res.checkout.title, amount: res.checkout.amount }],
      { provider_token: '' },
    );
  } else if (res.checkout.kind === 'url') {
    await ctx.reply(`🧾 Пополнение на <b>${coins(amount)}</b> ${COIN}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .url('💳 Оплатить', res.checkout.url)
        .row()
        .text('← К счёту', 'shop:wallet'),
    });
  }
}

// ─── приглашения ──────────────────────────────────────────────────────────

async function showInvite(ctx: BotContext, edit: boolean): Promise<void> {
  const { text, keyboard } = UI.renderInvite(await inviteCard(ctx.user.id));
  const opts = { parse_mode: 'HTML', reply_markup: keyboard } as const;
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

shopHandler.command('invite', (ctx) => showInvite(ctx, false));

shopHandler.callbackQuery('shop:invite', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showInvite(ctx, true);
});

shopHandler.callbackQuery('menu:invite', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showInvite(ctx, false);
});

// ─── платёжные апдейты Telegram ───────────────────────────────────────────

/**
 * Последняя проверка перед списанием звёзд. Ответить нужно за 10 секунд,
 * иначе Telegram сам отменит платёж, поэтому здесь только один быстрый
 * запрос — и никакой выдачи товара.
 */
shopHandler.on('pre_checkout_query', async (ctx) => {
  const orderId = ctx.preCheckoutQuery.invoice_payload;
  payLog.info(
    {
      step: 'pre_checkout',
      orderId,
      tgId: ctx.from.id,
      amount: ctx.preCheckoutQuery.total_amount,
      currency: ctx.preCheckoutQuery.currency,
    },
    'Telegram спрашивает подтверждение',
  );
  try {
    const order = await P.byOrderId(orderId);
    if (!order) {
      payLog.warn({ step: 'pre_checkout_rejected', orderId, reason: 'not_found' }, 'заказ не найден');
      await ctx.answerPreCheckoutQuery(false, { error_message: 'Заказ не найден. Открой магазин заново.' });
      return;
    }
    if (order.status !== 'pending') {
      payLog.warn({ step: 'pre_checkout_rejected', orderId, reason: 'status', status: order.status }, 'заказ уже закрыт');
      await ctx.answerPreCheckoutQuery(false, { error_message: 'Этот заказ уже закрыт.' });
      return;
    }
    if (order.amountMinor !== ctx.preCheckoutQuery.total_amount) {
      payLog.error(
        { step: 'pre_checkout_rejected', orderId, reason: 'amount', expected: order.amountMinor, got: ctx.preCheckoutQuery.total_amount },
        'сумма в pre_checkout не совпала с заказом',
      );
      await ctx.answerPreCheckoutQuery(false, { error_message: 'Цена изменилась. Открой магазин заново.' });
      return;
    }
    payLog.info({ step: 'pre_checkout_ok', orderId }, 'подтверждаю заказ');
    await ctx.answerPreCheckoutQuery(true);
  } catch (e) {
    payLog.error({ step: 'pre_checkout_failed', err: e, orderId }, 'pre_checkout сорвался');
    await ctx
      .answerPreCheckoutQuery(false, { error_message: 'Не смог подтвердить заказ. Попробуй ещё раз.' })
      .catch(() => {});
  }
});

/**
 * Оплата прошла. Выдачу делает `settle` — она же переживает повторную
 * доставку этого апдейта, поэтому здесь ничего проверять не нужно.
 */
shopHandler.on('message:successful_payment', async (ctx) => {
  const sp = ctx.message.successful_payment;
  payLog.info(
    {
      step: 'successful_payment',
      orderId: sp.invoice_payload,
      tgId: ctx.from.id,
      amount: sp.total_amount,
      currency: sp.currency,
      telegramChargeId: sp.telegram_payment_charge_id,
    },
    'Telegram сообщил об оплате',
  );
  await settle(ctx.api, {
    orderId: sp.invoice_payload,
    externalId: sp.provider_payment_charge_id || sp.telegram_payment_charge_id,
    telegramChargeId: sp.telegram_payment_charge_id,
    metadata: { currency: sp.currency, totalAmount: sp.total_amount },
  });
});

/**
 * Telegram требует, чтобы бот, принимающий звёзды, отвечал на /paysupport.
 * Без этого магазин формально нарушает правила.
 */
shopHandler.command('paysupport', async (ctx) => {
  const recent = await P.listForUser(ctx.user.id, 5);
  const lines = recent.length
    ? recent.map((p) => {
        const when = p.createdAt.toLocaleDateString('ru-RU');
        return `<code>${when}</code> · ${p.amountMinor} ${p.currency} · ${p.status}`;
      })
    : ['Покупок пока не было.'];

  await ctx.reply(
    [
      '💬 <b>Поддержка по оплате</b>',
      '',
      'Колоды открываются навсегда и работают во всех твоих комнатах.',
      'Если оплата прошла, а колода не открылась — напиши нам через /feedback,',
      'приложи дату и сумму. Разберёмся и вернём деньги, если что-то пошло не так.',
      '',
      '<b>Твои последние платежи</b>',
      ...lines,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});
