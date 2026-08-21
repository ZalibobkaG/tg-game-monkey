import { Composer } from 'grammy';
import { sql } from 'drizzle-orm';
import type { BotContext } from '../types.js';
import { db } from '../db/index.js';
import * as S from '../repo/stats.js';
import * as R from '../repo/rooms.js';
import * as F from '../repo/feedback.js';
import { atLeast, listAdmins, roleOf } from '../repo/admins.js';
import type { AdminRole } from '../repo/admins.js';
import { cachedUsers, getUserById, setBanned } from '../repo/users.js';
import {
  addDeckItems,
  countDeckItems,
  deckActions,
  decksFor,
  deckSummary,
  getDeck,
  grantDeck,
  replaceDeckItems,
  revokeDeck,
  setDeckActive,
  setDeckPremium,
  setDeckPrice,
} from '../repo/decks.js';
import type { Deck, PriceField } from '../repo/decks.js';
import * as Pay from '../repo/payments.js';
import * as Wallet from '../repo/wallet.js';
import * as Referrals from '../repo/referrals.js';
import { getEconomy, patchEconomy } from '../repo/settings.js';
import type { Economy } from '../domain/economy.js';
import { isConfigured } from '../payments/index.js';
import { refundPayment } from '../services/purchase.js';
import { displayName } from '../repo/users.js';
import { parseActions } from '../domain/deckInput.js';
import type { DeckEditMode } from '../domain/deckInput.js';
import { abortGame, getLive, liveCount, liveGames } from '../services/game.js';
import { bufferSize } from '../services/analytics.js';
import { pendingLocks } from '../lib/mutex.js';
import * as pending from '../lib/pending.js';
import { closeLobby } from '../services/lobby.js';
import * as UI from '../ui/admin.js';
import { renderInbox } from '../ui/feedback.js';
import { trackAdminAction } from '../services/analytics.js';
import { log } from '../lib/log.js';

export const adminHandler = new Composer<BotContext>();

const STARTED_AT = Date.now();

/**
 * Доступ к панели. Не-админу отвечаем как на несуществующую команду:
 * панель не должна выдавать самим фактом отказа, что она существует.
 */
async function gate(ctx: BotContext, needed: AdminRole = 'support'): Promise<AdminRole | null> {
  const role = await roleOf(ctx.user);
  if (!role) return null;
  if (!atLeast(role, needed)) {
    await ctx.answerCallbackQuery({ text: 'Недостаточно прав.', show_alert: true }).catch(() => {});
    return null;
  }
  return role;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);
const daysAhead = (n: number): Date => new Date(Date.now() + n * DAY_MS);
const BAN_DAYS = 30;

async function showHome(ctx: BotContext, role: AdminRole, edit: boolean): Promise<void> {
  const counts = await F.countByStatus();
  const rooms = await R.listOpenRooms(50);
  const { text, keyboard } = UI.renderHome({
    role,
    newFeedback: counts.new,
    liveGames: liveCount(),
    openRooms: rooms.length,
  });
  const opts = { parse_mode: 'HTML', reply_markup: keyboard } as const;
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

adminHandler.command('admin', async (ctx) => {
  const role = await roleOf(ctx.user);
  if (!role) return;
  await showHome(ctx, role, false);
});

adminHandler.callbackQuery('adm:home', async (ctx) => {
  const role = await gate(ctx);
  if (!role) return;
  await ctx.answerCallbackQuery();
  await showHome(ctx, role, true);
});

// ─── статистика ───────────────────────────────────────────────────────────

adminHandler.callbackQuery(/^adm:stats:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();

  const days = Number(ctx.match![1]);
  const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)) : daysAgo(days);
  const to = new Date();

  const [stats, decks, signal] = await Promise.all([
    S.periodStats(from, to),
    S.deckUsage(from, to),
    S.signalHealth(from, to),
  ]);

  const { text, keyboard } = UI.renderStats({ days, stats, decks, signal });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── обращения ────────────────────────────────────────────────────────────

adminHandler.callbackQuery('adm:fb', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const [items, counts] = await Promise.all([F.listFeedback({ status: 'new', limit: 10 }), F.countByStatus()]);
  const { text, keyboard } = renderInbox(items, counts);
  keyboard.row().text('← Назад', 'adm:home');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── пользователи ─────────────────────────────────────────────────────────

adminHandler.callbackQuery('adm:users', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'admin_search');
  await ctx.reply(UI.renderSearchPrompt(), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: '@username или tg_id' },
  });
});

async function showUser(ctx: BotContext, userId: number, viewer: AdminRole): Promise<void> {
  const card = await S.userCard(userId);
  if (!card) {
    await ctx.reply('Пользователь не найден.');
    return;
  }
  const [decks, targetRole, wallet, refStats, invitedBy] = await Promise.all([
    decksFor(userId),
    roleOf(card.user),
    Wallet.getWallet(userId),
    Referrals.statsOf(userId),
    Referrals.referrerOf(userId),
  ]);

  const referrer = invitedBy ? await getUserById(invitedBy.referrerId) : null;

  const { text, keyboard } = UI.renderUserCard({
    card,
    decks,
    role: targetRole,
    canModerate: atLeast(viewer, 'moderator'),
    balance: wallet.balance,
    spent: wallet.totalSpent,
    invited: refStats.invited,
    referrerName: referrer ? displayName(referrer) : null,
  });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

adminHandler.callbackQuery(/^adm:user:(\d+)$/, async (ctx) => {
  const role = await gate(ctx);
  if (!role) return;
  await ctx.answerCallbackQuery();
  await showUser(ctx, Number(ctx.match![1]), role);
});

adminHandler.callbackQuery(/^adm:(grant|revoke):(\d+):(\d+)$/, async (ctx) => {
  const role = await gate(ctx, 'moderator');
  if (!role) return;
  const [, action, rawUser, rawDeck] = ctx.match!;
  const userId = Number(rawUser);
  const deckId = Number(rawDeck);

  if (action === 'grant') await grantDeck(userId, deckId);
  else await revokeDeck(userId, deckId);
  trackAdminAction(ctx.user.id, action === 'grant' ? 'выдал колоду' : 'забрал колоду', userId, { deckId });

  await ctx.answerCallbackQuery({ text: action === 'grant' ? 'Выдал.' : 'Забрал.' });
  await showUser(ctx, userId, role);
});

adminHandler.callbackQuery(/^adm:ban:(\d+)$/, async (ctx) => {
  const role = await gate(ctx, 'moderator');
  if (!role) return;
  const userId = Number(ctx.match![1]);
  const target = await getUserById(userId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: 'Не найден.', show_alert: true });
    return;
  }
  const banned = target.bannedUntil !== null && target.bannedUntil > new Date();
  await setBanned(target, banned ? null : daysAhead(BAN_DAYS));
  trackAdminAction(ctx.user.id, banned ? 'разбанил' : 'забанил', userId, { days: banned ? 0 : BAN_DAYS });
  log.warn({ admin: ctx.user.tgId, target: target.tgId, banned: !banned }, 'модерация: изменён бан');
  await ctx.answerCallbackQuery({ text: banned ? 'Разбанил.' : `Забанил на ${BAN_DAYS} дней.` });
  await showUser(ctx, userId, role);
});

// ─── комнаты ──────────────────────────────────────────────────────────────

adminHandler.callbackQuery('adm:rooms', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const rooms = await R.listOpenRooms(20);
  const liveRounds = new Map(
    liveGames().map((g) => [g.roomId, { round: g.currentRound, phase: g.phase }] as const),
  );
  const { text, keyboard } = UI.renderRooms({ rooms, liveRounds });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery(/^adm:kill:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  const roomId = Number(ctx.match![1]);
  const room = await R.getRoom(roomId);
  if (!room) {
    await ctx.answerCallbackQuery({ text: 'Комната не найдена.', show_alert: true });
    return;
  }
  if (getLive(roomId)) await abortGame(ctx.api, roomId, 'Партию закрыл администратор.');
  const members = await R.listMembers(roomId);
  await R.closeRoom(roomId);
  await closeLobby(ctx.api, room, members, 'Комнату закрыл администратор.').catch(() => {});
  trackAdminAction(ctx.user.id, 'закрыл комнату', null, { roomId, code: room.code });
  await ctx.answerCallbackQuery({ text: `Комната ${room.code} закрыта.` });
});

// ─── колоды, лидеры, система ──────────────────────────────────────────────

adminHandler.callbackQuery('adm:decks', async (ctx) => {
  const role = await gate(ctx);
  if (!role) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderDecks(await deckSummary(), atLeast(role, 'moderator'));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery(/^adm:deck:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  const deck = await getDeck(Number(ctx.match![1]));
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderDeckCard(deck, await deckActions(deck.id));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery(/^adm:deck(add|set):(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  const mode: DeckEditMode = ctx.match![1] === 'set' ? 'set' : 'add';
  const deck = await getDeck(Number(ctx.match![2]));
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await askForActions(ctx, deck, mode);
});

/**
 * Приглашение прислать действия. `force_reply` важен: по заголовку ответа
 * восстанавливаем колоду и режим, даже если состояние в памяти протухло
 * или админов в общем чате несколько.
 */
async function askForActions(
  ctx: BotContext,
  deck: Deck,
  mode: DeckEditMode,
  errors?: string[],
): Promise<void> {
  pending.expect(ctx.user.tgId, 'deck_items', `${mode}:${deck.id}`);
  const current = await countDeckItems(deck.id);
  await ctx.reply(UI.renderDeckPrompt({ deck, mode, current, errors }), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Одно действие — одна строка' },
  });
}

async function applyActions(
  ctx: BotContext,
  deckId: number,
  mode: DeckEditMode,
  raw: string,
): Promise<void> {
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.reply('Колода не найдена — возможно, её удалили.');
    return;
  }

  const existing = await deckActions(deckId);
  const parsed = parseActions({ raw, mode, existing });
  if (!parsed.ok) {
    // Отбойник — то же приглашение с разбором ошибок: админ отвечает на него
    // и остаётся в том же режиме, ничего не нажимая заново.
    await askForActions(ctx, deck, mode, parsed.errors);
    return;
  }

  if (mode === 'set') await replaceDeckItems(deckId, parsed.items);
  else await addDeckItems(deckId, parsed.items);

  trackAdminAction(ctx.user.id, mode === 'set' ? 'заменил колоду' : 'дополнил колоду', null, {
    deckId,
    deckSlug: deck.slug,
    added: parsed.items.length,
    total: parsed.total,
  });
  log.info(
    { admin: ctx.user.tgId, deck: deck.slug, mode, added: parsed.items.length, total: parsed.total },
    'колода изменена',
  );

  const { text, keyboard } = UI.renderDeckSaved({
    deck,
    mode,
    added: parsed.items.length,
    total: parsed.total,
  });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/** `add:12` / `set:12` из pending-состояния. */
function deckTaskFromPayload(payload?: string): { deckId: number; mode: DeckEditMode } | null {
  const m = /^(add|set):(\d+)$/.exec(payload ?? '');
  if (!m) return null;
  return { deckId: Number(m[2]), mode: m[1] === 'set' ? 'set' : 'add' };
}

/** `12:rub` из pending-состояния. */
function priceTaskFromPayload(payload?: string): { deckId: number; field: PriceField } | null {
  const m = /^(\d+):(rub|stars|coins)$/.exec(payload ?? '');
  if (!m) return null;
  return { deckId: Number(m[1]), field: m[2] as PriceField };
}

adminHandler.callbackQuery('adm:top', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderTop(await S.topPlayers(10));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery('adm:sys', async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();

  const t0 = Date.now();
  await db.execute(sql`select 1`);
  const dbLatencyMs = Date.now() - t0;

  const { text, keyboard } = UI.renderSystem({
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    liveGames: liveCount(),
    pendingLocks: pendingLocks(),
    cachedUsers: cachedUsers(),
    analyticsBuffer: bufferSize(),
    dbLatencyMs,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    admins: await listAdmins(),
  });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

/** Что показываем на каждой вкладке журнала. */
const JOURNAL_TYPES: Record<UI.JournalMode, string[] | undefined> = {
  admin: ['admin_action'],
  pay: ['purchase_started', 'purchase_paid', 'shop_opened', 'referral_attached', 'referral_bonus'],
  all: undefined,
};

adminHandler.callbackQuery(/^adm:log:(admin|pay|all)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const mode = ctx.match![1] as UI.JournalMode;
  const types = JOURNAL_TYPES[mode];
  const rows = await S.recentEvents(types ? { types, limit: 25 } : { limit: 25 });
  const { text, keyboard } = UI.renderJournal(rows, mode);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── оплата, тарифы, рефералка ────────────────────────────────────────────

/** Какие провайдеры настроены ключами — панель показывает это отдельно от «включён». */
const configuredMap = (): Record<string, boolean> => ({
  stars: isConfigured('stars'),
  yookassa: isConfigured('yookassa'),
  cryptobot: isConfigured('cryptobot'),
});

async function showPayHome(ctx: BotContext, days: number): Promise<void> {
  const [revenue, economy] = await Promise.all([Pay.revenueSince(daysAgo(days)), getEconomy()]);
  const { text, keyboard } = UI.renderPayHome({
    revenue,
    economy,
    configured: configuredMap(),
    days,
  });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
}

adminHandler.callbackQuery(/^adm:pay:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  await showPayHome(ctx, Number(ctx.match![1]));
});

adminHandler.callbackQuery('adm:providers', async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderProviders({
    economy: await getEconomy(),
    configured: configuredMap(),
  });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery(/^adm:prov:(stars|yookassa|cryptobot|wallet)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const id = ctx.match![1] as keyof Economy['providers'];

  // Включить провайдера без ключей нельзя: иначе человек дойдёт до кнопки
  // «оплатить» и упрётся в ошибку кассы вместо счёта.
  if (id !== 'wallet' && !isConfigured(id)) {
    await ctx.answerCallbackQuery({
      text: 'Нет ключей в окружении — сначала пропиши их и перезапусти бота.',
      show_alert: true,
    });
    return;
  }

  const next = await patchEconomy(ctx.user.id, (e) => ({
    ...e,
    providers: { ...e.providers, [id]: !e.providers[id] },
  }));
  const on = next.providers[id];
  trackAdminAction(ctx.user.id, on ? 'включил способ оплаты' : 'выключил способ оплаты', null, { provider: id });
  log.warn({ admin: ctx.user.tgId, provider: id, enabled: on }, 'способ оплаты переключён');

  await ctx.answerCallbackQuery({ text: on ? 'Включил.' : 'Выключил.' });
  const { text, keyboard } = UI.renderProviders({ economy: next, configured: configuredMap() });
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── тарифы колод ─────────────────────────────────────────────────────────

adminHandler.callbackQuery('adm:tariffs', async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderTariffs(await deckSummary());
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

async function showTariff(ctx: BotContext, deckId: number, edit: boolean): Promise<void> {
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.reply('Колода не найдена.');
    return;
  }
  const { text, keyboard } = UI.renderTariffCard(deck);
  const opts = { parse_mode: 'HTML', reply_markup: keyboard } as const;
  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else await ctx.reply(text, opts);
}

adminHandler.callbackQuery(/^adm:tariff:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  await showTariff(ctx, Number(ctx.match![1]), true);
});

adminHandler.callbackQuery(/^adm:price:(\d+):(rub|stars|coins)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const deckId = Number(ctx.match![1]);
  const field = ctx.match![2] as PriceField;
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await askForPrice(ctx, deck, field);
});

const currentPrice = (deck: Deck, field: PriceField): number =>
  field === 'rub' ? deck.priceRub : field === 'stars' ? deck.priceStars : deck.priceCoins;

async function askForPrice(ctx: BotContext, deck: Deck, field: PriceField): Promise<void> {
  pending.expect(ctx.user.tgId, 'deck_price', `${deck.id}:${field}`);
  await ctx.reply(UI.renderPricePrompt(deck, field, currentPrice(deck, field)), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Число, например 199' },
  });
}

/**
 * Разбор числа из ответа админа. Отдельной функцией, потому что через неё
 * проходят и цены, и настройки экономики: пустить туда NaN или минус —
 * значит получить колоду за −100 ₽.
 */
function parseAmount(raw: string, opts: { min: number; max: number }): number | null {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(',', '.');
  // Ведущий «+» обязателен к приёму: правку баланса мы сами просим слать
  // как «+100», и отвергать собственный же формат было бы издевательством.
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Math.round(Number(cleaned));
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) return null;
  return n;
}

const MAX_PRICE = 1_000_000;

async function applyPrice(ctx: BotContext, deckId: number, field: PriceField, raw: string): Promise<void> {
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.reply('Колода не найдена — возможно, её удалили.');
    return;
  }

  const value = parseAmount(raw, { min: 0, max: MAX_PRICE });
  if (value === null) {
    await ctx.reply(`⚠️ Нужно целое число от 0 до ${MAX_PRICE}.`);
    await askForPrice(ctx, deck, field);
    return;
  }

  await setDeckPrice(deckId, field, value);
  trackAdminAction(ctx.user.id, 'изменил цену колоды', null, {
    deckId,
    deckSlug: deck.slug,
    field,
    from: currentPrice(deck, field),
    to: value,
  });
  log.warn(
    { admin: ctx.user.tgId, deck: deck.slug, field, from: currentPrice(deck, field), to: value },
    'цена колоды изменена',
  );

  await ctx.reply(`✅ Новая цена «${UI.esc(deck.title)}» (${field}): <b>${value}</b>`, { parse_mode: 'HTML' });
  await showTariff(ctx, deckId, false);
}

adminHandler.callbackQuery(/^adm:premium:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const deckId = Number(ctx.match![1]);
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  await setDeckPremium(deckId, !deck.isPremium);
  trackAdminAction(ctx.user.id, deck.isPremium ? 'сделал колоду бесплатной' : 'сделал колоду платной', null, {
    deckId,
    deckSlug: deck.slug,
  });
  await ctx.answerCallbackQuery({ text: deck.isPremium ? 'Теперь бесплатная.' : 'Теперь платная.' });
  await showTariff(ctx, deckId, true);
});

adminHandler.callbackQuery(/^adm:deckactive:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const deckId = Number(ctx.match![1]);
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  await setDeckActive(deckId, !deck.active);
  trackAdminAction(ctx.user.id, deck.active ? 'снял колоду с продажи' : 'вернул колоду в продажу', null, {
    deckId,
    deckSlug: deck.slug,
  });
  await ctx.answerCallbackQuery({
    text: deck.active ? 'Снял с продажи. Купившие сохранят доступ.' : 'Вернул в продажу.',
    show_alert: true,
  });
  await showTariff(ctx, deckId, true);
});

// ─── реферальная программа ────────────────────────────────────────────────

async function showReferral(ctx: BotContext, economy?: Economy): Promise<void> {
  const { text, keyboard } = UI.renderReferral(economy ?? (await getEconomy()));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
}

adminHandler.callbackQuery('adm:ref', async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  await showReferral(ctx);
});

adminHandler.callbackQuery('adm:ref:toggle', async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const next = await patchEconomy(ctx.user.id, (e) => ({
    ...e,
    referral: { ...e.referral, enabled: !e.referral.enabled },
  }));
  trackAdminAction(ctx.user.id, next.referral.enabled ? 'включил рефералку' : 'выключил рефералку');
  log.warn({ admin: ctx.user.tgId, enabled: next.referral.enabled }, 'рефералка переключена');
  await ctx.answerCallbackQuery({ text: next.referral.enabled ? 'Включил.' : 'Выключил.' });
  await showReferral(ctx, next);
});

adminHandler.callbackQuery('adm:reftop', async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderReferralTop(await Referrals.topReferrers(10));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

/** Числовые настройки экономики: где лежит поле и в каких границах живёт. */
const ECON_FIELDS = {
  inviteeBonus: { group: 'referral', max: 100_000 },
  inviterBonus: { group: 'referral', max: 100_000 },
  purchasePercent: { group: 'referral', max: 100 },
  perReferralCap: { group: 'referral', max: 1_000_000 },
  coinsPerRub: { group: 'rates', max: 10_000 },
  coinsPerStar: { group: 'rates', max: 10_000 },
} as const;

type EconField = keyof typeof ECON_FIELDS;

const isEconField = (v: string): v is EconField => v in ECON_FIELDS;

const econValue = (e: Economy, field: EconField): number => {
  const group = ECON_FIELDS[field].group;
  return group === 'referral'
    ? (e.referral[field as keyof Economy['referral']] as number)
    : (e.rates[field as keyof Economy['rates']] as number);
};

adminHandler.callbackQuery(/^adm:econ:([A-Za-z]+)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const field = ctx.match![1]!;
  if (!isEconField(field)) {
    await ctx.answerCallbackQuery({ text: 'Неизвестная настройка.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await askForEcon(ctx, field);
});

async function askForEcon(ctx: BotContext, field: EconField): Promise<void> {
  pending.expect(ctx.user.tgId, 'econ_value', field);
  const current = econValue(await getEconomy(), field);
  await ctx.reply(UI.renderEconPrompt(field, current), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Число' },
  });
}

async function applyEcon(ctx: BotContext, field: EconField, raw: string): Promise<void> {
  const spec = ECON_FIELDS[field];
  const value = parseAmount(raw, { min: 0, max: spec.max });
  if (value === null) {
    await ctx.reply(`⚠️ Нужно целое число от 0 до ${spec.max}.`);
    await askForEcon(ctx, field);
    return;
  }

  const next = await patchEconomy(ctx.user.id, (e) =>
    spec.group === 'referral'
      ? { ...e, referral: { ...e.referral, [field]: value } }
      : { ...e, rates: { ...e.rates, [field]: value } },
  );
  trackAdminAction(ctx.user.id, 'изменил настройку экономики', null, { field, to: value });
  log.warn({ admin: ctx.user.tgId, field, value }, 'настройка экономики изменена');

  await ctx.reply(`✅ <b>${field}</b> теперь <b>${value}</b>.`, { parse_mode: 'HTML' });
  const { text, keyboard } = UI.renderReferral(next);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── платежи и возвраты ───────────────────────────────────────────────────

adminHandler.callbackQuery('adm:payments', async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderPayments(await Pay.recent(20));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

adminHandler.callbackQuery(/^adm:refund:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'owner'))) return;
  const paymentId = Number(ctx.match![1]);
  await ctx.answerCallbackQuery({ text: 'Оформляю возврат…' });

  const res = await refundPayment(ctx.api, paymentId);
  trackAdminAction(ctx.user.id, res.ok ? 'вернул платёж' : 'не смог вернуть платёж', null, {
    paymentId,
    message: res.message,
  });
  log.warn({ admin: ctx.user.tgId, paymentId, ok: res.ok }, 'возврат платежа');

  await ctx.reply(`${res.ok ? '↩️' : '⚠️'} ${res.message}`);
  const { text, keyboard } = UI.renderPayments(await Pay.recent(20));
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── правка личного счёта ─────────────────────────────────────────────────

adminHandler.callbackQuery(/^adm:bal:(\d+)$/, async (ctx) => {
  if (!(await gate(ctx, 'moderator'))) return;
  const userId = Number(ctx.match![1]);
  const target = await getUserById(userId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: 'Не найден.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'wallet_adjust', String(userId));
  await ctx.reply(
    UI.renderBalancePrompt(userId, displayName(target), await Wallet.balanceOf(userId)),
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: '+100 или -50' },
    },
  );
});

const MAX_ADJUST = 1_000_000;

async function applyBalance(ctx: BotContext, userId: number, raw: string, viewer: AdminRole): Promise<void> {
  const delta = parseAmount(raw, { min: -MAX_ADJUST, max: MAX_ADJUST });
  if (delta === null || delta === 0) {
    await ctx.reply(`⚠️ Нужно число со знаком, например <code>+100</code> или <code>-50</code>.`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const res = await Wallet.adjust(userId, delta, ctx.user.id, `Правка из панели`);
  if (!res.ok) {
    await ctx.reply(`⚠️ Не хватает средств: на счету ${res.balance}. В минус уводить нельзя.`);
    return;
  }

  trackAdminAction(ctx.user.id, 'изменил баланс', userId, { delta, balance: res.balance });
  log.warn({ admin: ctx.user.tgId, target: userId, delta }, 'баланс изменён из панели');
  await ctx.reply(`✅ Готово. Баланс: <b>${res.balance}</b>`, { parse_mode: 'HTML' });
  await showUser(ctx, userId, viewer);
}

// ─── поиск текстом ────────────────────────────────────────────────────────

adminHandler.on('message:text', async (ctx, next) => {
  // Команды пропускаем дальше по цепочке: их обработчики зарегистрированы
  // позже, а этот — раньше. Иначе «/cancel» уехал бы в колоду как действие.
  if (ctx.message.text.startsWith('/')) return next();

  // Реплай на приглашение работает в любом чате: весь контекст в самом
  // сообщении. Состояние в памяти — только для лички, иначе в общем
  // админ-чате двое ищущих одновременно перебивали бы друг друга.
  const source = ctx.message.reply_to_message;
  const fromBot = source?.from?.id === ctx.me.id && source !== undefined && 'text' in source;
  const sourceText = fromBot ? (source.text ?? '') : '';

  const waiting = pending.peek(ctx.user.tgId);
  const inPrivate = ctx.chat.type === 'private';

  // ── правка колоды ───────────────────────────────────────────────────────
  const fromReply = UI.DECK_PROMPT_RE.exec(sourceText);
  const deckTask = fromReply
    ? { deckId: Number(fromReply[1]), mode: (fromReply[2] === 'замена' ? 'set' : 'add') as DeckEditMode }
    : inPrivate && waiting?.kind === 'deck_items'
      ? deckTaskFromPayload(waiting.payload)
      : null;

  if (deckTask) {
    pending.clear(ctx.user.tgId);
    const role = await roleOf(ctx.user);
    if (!role || !atLeast(role, 'moderator')) return;
    return applyActions(ctx, deckTask.deckId, deckTask.mode, ctx.message.text);
  }

  // ── цена колоды ─────────────────────────────────────────────────────────
  const priceReply = UI.PRICE_PROMPT_RE.exec(sourceText);
  const priceTask = priceReply
    ? { deckId: Number(priceReply[1]), field: priceReply[2] as PriceField }
    : inPrivate && waiting?.kind === 'deck_price'
      ? priceTaskFromPayload(waiting.payload)
      : null;

  if (priceTask) {
    pending.clear(ctx.user.tgId);
    const role = await roleOf(ctx.user);
    if (!role || !atLeast(role, 'owner')) return;
    return applyPrice(ctx, priceTask.deckId, priceTask.field, ctx.message.text);
  }

  // ── настройка экономики ─────────────────────────────────────────────────
  const econReply = UI.ECON_PROMPT_RE.exec(sourceText);
  const econField = econReply?.[1] ?? (inPrivate && waiting?.kind === 'econ_value' ? waiting.payload : undefined);

  if (econField && isEconField(econField)) {
    pending.clear(ctx.user.tgId);
    const role = await roleOf(ctx.user);
    if (!role || !atLeast(role, 'owner')) return;
    return applyEcon(ctx, econField, ctx.message.text);
  }

  // ── правка баланса ──────────────────────────────────────────────────────
  const balReply = UI.BALANCE_PROMPT_RE.exec(sourceText);
  const balUserId = balReply
    ? Number(balReply[1])
    : inPrivate && waiting?.kind === 'wallet_adjust'
      ? Number(waiting.payload)
      : null;

  if (balUserId !== null && Number.isFinite(balUserId)) {
    pending.clear(ctx.user.tgId);
    const role = await roleOf(ctx.user);
    if (!role || !atLeast(role, 'moderator')) return;
    return applyBalance(ctx, balUserId, ctx.message.text, role);
  }

  // ── поиск пользователя ──────────────────────────────────────────────────
  const repliedToSearch = UI.SEARCH_PROMPT_RE.test(sourceText);
  const viaState = inPrivate && waiting?.kind === 'admin_search';
  if (!repliedToSearch && !viaState) return next();

  pending.clear(ctx.user.tgId);
  const role = await roleOf(ctx.user);
  if (!role) return;

  const found = await S.findUsers(ctx.message.text.trim(), 10);
  const { text, keyboard } = UI.renderSearchResults(found);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});
