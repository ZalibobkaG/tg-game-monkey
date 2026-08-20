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
import { decksFor, deckSummary, grantDeck, revokeDeck } from '../repo/decks.js';
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
  const [decks, targetRole] = await Promise.all([decksFor(userId), roleOf(card.user)]);
  const { text, keyboard } = UI.renderUserCard({
    card,
    decks,
    role: targetRole,
    canModerate: atLeast(viewer, 'moderator'),
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
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const { text, keyboard } = UI.renderDecks(await deckSummary());
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

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

adminHandler.callbackQuery(/^adm:log:(admin|all)$/, async (ctx) => {
  if (!(await gate(ctx))) return;
  await ctx.answerCallbackQuery();
  const mode = ctx.match![1] as 'admin' | 'all';
  const rows = await S.recentEvents(mode === 'admin' ? { types: ['admin_action'], limit: 25 } : { limit: 25 });
  const { text, keyboard } = UI.renderJournal(rows, mode);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
});

// ─── поиск текстом ────────────────────────────────────────────────────────

adminHandler.on('message:text', async (ctx, next) => {
  // Реплай на приглашение работает в любом чате: весь контекст в самом
  // сообщении. Состояние в памяти — только для лички, иначе в общем
  // админ-чате двое ищущих одновременно перебивали бы друг друга.
  const source = ctx.message.reply_to_message;
  const repliedToPrompt =
    source?.from?.id === ctx.me.id &&
    source !== undefined &&
    'text' in source &&
    UI.SEARCH_PROMPT_RE.test(source.text ?? '');

  const waiting = pending.peek(ctx.user.tgId);
  const viaState = ctx.chat.type === 'private' && waiting?.kind === 'admin_search';
  if (!repliedToPrompt && !viaState) return next();

  pending.clear(ctx.user.tgId);
  const role = await roleOf(ctx.user);
  if (!role) return;

  const found = await S.findUsers(ctx.message.text.trim(), 10);
  const { text, keyboard } = UI.renderSearchResults(found);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});
