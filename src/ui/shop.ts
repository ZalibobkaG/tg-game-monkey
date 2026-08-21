import { InlineKeyboard } from 'grammy';
import type { Deck } from '../repo/decks.js';
import type { ProviderAdapter } from '../payments/index.js';
import type { LedgerRow } from '../repo/wallet.js';
import type { InviteCard } from '../services/referral.js';
import { COIN, coins } from '../domain/economy.js';
import { esc } from './lobby.js';

/**
 * Витрина, кошелёк и приглашения. Только отрисовка — ни запросов,
 * ни решений о том, что человеку доступно.
 */

/** Цена колоды на кнопке конкретной кассы. */
function priceLabel(deck: Deck, provider: ProviderAdapter): string | null {
  if (provider.id === 'stars') return deck.priceStars > 0 ? `⭐ ${deck.priceStars}` : null;
  return deck.priceRub > 0 ? `${deck.priceRub} ₽` : null;
}

/** Строка с ценой во всех валютах сразу — для карточки колоды. */
function priceLine(deck: Deck, providers: ProviderAdapter[], walletOn: boolean): string {
  const parts: string[] = [];
  if (providers.some((p) => p.id === 'stars') && deck.priceStars > 0) parts.push(`⭐ ${deck.priceStars}`);
  if (providers.some((p) => p.id !== 'stars') && deck.priceRub > 0) parts.push(`${deck.priceRub} ₽`);
  if (walletOn && deck.priceCoins > 0) parts.push(`${deck.priceCoins} ${COIN}`);
  return parts.length ? parts.join(' · ') : 'цена не назначена';
}

export function renderShop(args: {
  decks: Array<Deck & { owned: boolean }>;
  providers: ProviderAdapter[];
  walletOn: boolean;
  balance: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { decks, providers, walletOn, balance } = args;
  const forSale = decks.filter((d) => d.isPremium && d.active);

  const lines = forSale.length
    ? forSale.map((d) => {
        const price = d.owned ? '✅ куплена' : priceLine(d, providers, walletOn);
        return `<b>${esc(d.title)}</b> — ${price}\n     <i>${esc(d.description)}</i>`;
      })
    : ['Платных колод пока нет — всё бесплатно.'];

  const keyboard = new InlineKeyboard();
  for (const d of forSale) {
    keyboard.text(`${d.owned ? '✅ ' : '🛒 '}${d.title}`, `shop:deck:${d.id}`).row();
  }
  if (walletOn) keyboard.text(`${COIN} Счёт: ${balance}`, 'shop:wallet').row();
  keyboard.text('🎁 Пригласить друзей', 'shop:invite').row();
  keyboard.text('← В меню', 'shop:close');

  return {
    text: [
      '🛒 <b>Магазин колод</b>',
      '',
      ...lines,
      ...(walletOn ? ['', `${COIN} На счету: <b>${balance}</b>`] : []),
    ].join('\n'),
    keyboard,
  };
}

export function renderDeckOffer(args: {
  deck: Deck & { owned: boolean };
  providers: ProviderAdapter[];
  walletOn: boolean;
  balance: number;
  actionsCount: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { deck, providers, walletOn, balance, actionsCount } = args;

  const keyboard = new InlineKeyboard();
  if (deck.owned) {
    keyboard.text('← К колодам', 'shop:home');
    return {
      text: [
        `✅ <b>${esc(deck.title)}</b>`,
        '',
        esc(deck.description),
        '',
        'Колода уже твоя — выбирай её в лобби перед стартом.',
      ].join('\n'),
      keyboard,
    };
  }

  for (const p of providers) {
    const label = priceLabel(deck, p);
    if (label) keyboard.text(`${p.title} — ${label}`, `shop:buy:${deck.id}:${p.id}`).row();
  }
  // Кнопку оплаты со счёта показываем всегда, когда цена в 🍌 назначена:
  // с недостатком средств человеку честнее столкнуться на кнопке, чем
  // гадать, почему способ оплаты вообще не предложили.
  if (walletOn && deck.priceCoins > 0) {
    const enough = balance >= deck.priceCoins;
    keyboard
      .text(`${COIN} Со счёта — ${deck.priceCoins}${enough ? '' : ' (не хватает)'}`, `shop:buy:${deck.id}:wallet`)
      .row();
  }
  keyboard.text('← К колодам', 'shop:home');

  return {
    text: [
      `🎴 <b>${esc(deck.title)}</b>`,
      '',
      esc(deck.description),
      '',
      `Действий в колоде: <b>${actionsCount}</b>`,
      `Цена: <b>${priceLine(deck, providers, walletOn)}</b>`,
      ...(walletOn ? ['', `${COIN} На счету: ${balance}`] : []),
      '',
      '<i>Колода открывается навсегда и работает во всех твоих комнатах.</i>',
    ].join('\n'),
    keyboard,
  };
}

const REASON_LABELS: Record<string, string> = {
  topup: 'пополнение',
  purchase: 'покупка',
  refund: 'возврат',
  referral_bonus: 'за реферала',
  signup_bonus: 'за приглашение',
  admin_adjust: 'правка админом',
};

export function renderWallet(args: {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  history: LedgerRow[];
  topupOptions: number[];
  canTopup: boolean;
}): { text: string; keyboard: InlineKeyboard } {
  const { balance, totalEarned, totalSpent, history, topupOptions, canTopup } = args;

  const lines = history.length
    ? history.slice(0, 10).map((r) => {
        const when = r.createdAt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        const sign = r.delta > 0 ? '+' : '';
        const what = REASON_LABELS[r.reason] ?? r.reason;
        return `<code>${when}</code> ${sign}${r.delta} — ${what}${r.comment ? ` (${esc(r.comment)})` : ''}`;
      })
    : ['Движений пока не было.'];

  const keyboard = new InlineKeyboard();
  if (canTopup) {
    for (const amount of topupOptions) {
      keyboard.text(`+${amount} ${COIN}`, `shop:topup:${amount}`);
    }
    keyboard.row();
  }
  keyboard.text('🎁 Пригласить друзей', 'shop:invite').row();
  keyboard.text('← В магазин', 'shop:home');

  return {
    text: [
      `${COIN} <b>Личный счёт</b>`,
      '',
      `Баланс: <b>${coins(balance)}</b>`,
      `Всего получено: ${totalEarned} · потрачено: ${totalSpent}`,
      '',
      '<b>История</b>',
      ...lines,
      '',
      `<i>${COIN} — внутренняя валюта бота. Ей оплачивают колоды; вывести или обменять на деньги нельзя.</i>`,
    ].join('\n'),
    keyboard,
  };
}

export function renderInvite(card: InviteCard): { text: string; keyboard: InlineKeyboard } {
  const rules = card.enabled
    ? [
        '<b>Как это работает</b>',
        `• другу за первый запуск — <b>${coins(card.inviteeBonus)}</b> ${COIN}`,
        `• тебе за его первую покупку — <b>${coins(card.inviterBonus)}</b> ${COIN}`,
        ...(card.purchasePercent > 0
          ? [`• и <b>${card.purchasePercent}%</b> ${COIN} со всех его покупок дальше`]
          : []),
      ]
    : [
        '<i>Программа вознаграждений ещё готовится: бонусы включим позже,',
        'но приглашения уже засчитываются — зови друзей сейчас.</i>',
      ];

  return {
    text: [
      '🎁 <b>Пригласи друзей</b>',
      '',
      'В «Обезьянку» играют компанией — чем больше народу, тем веселее.',
      '',
      'Твоя ссылка:',
      `<code>${esc(card.link)}</code>`,
      '',
      `👥 Пришло по ссылке: <b>${card.invited}</b>`,
      ...(card.enabled ? [`${COIN} Заработано: <b>${card.earned}</b>`] : []),
      '',
      ...rules,
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .url('📤 Отправить другу', `https://t.me/share/url?url=${encodeURIComponent(card.link)}`)
      .row()
      .text(`${COIN} Мой счёт`, 'shop:wallet')
      .row()
      .text('← В магазин', 'shop:home'),
  };
}

/** Экран после успешной покупки со счёта — внешние кассы отвечают сами. */
export function renderPurchased(deck: Deck, balance: number): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      '✅ <b>Готово!</b>',
      '',
      `Колода «${esc(deck.title)}» открыта.`,
      `${COIN} Осталось на счету: <b>${balance}</b>`,
      '',
      'Выбирай её в лобби перед стартом партии.',
    ].join('\n'),
    keyboard: new InlineKeyboard().text('🛒 В магазин', 'shop:home').row().text('← В меню', 'shop:close'),
  };
}
