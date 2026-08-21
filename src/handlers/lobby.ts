import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types.js';
import * as R from '../repo/rooms.js';
import { deckActions, decksFor, getDeck, ownsDeck } from '../repo/decks.js';
import { RULES, canStart, voteEveryLabel } from '../domain/rules.js';
import { closeLobby, openLobbyFor, refreshLobby, refreshLobbySoon } from '../services/lobby.js';
import { renderCodePrompt, renderDeckPicker } from '../ui/lobby.js';
import { MAX_CODE_LEN, MIN_CODE_LEN } from '../lib/code.js';
import * as pending from '../lib/pending.js';
import { track, trackDeckLockedHit } from '../services/analytics.js';
import { roomQr } from '../services/qr.js';
import { displayName } from '../repo/users.js';
import { InputFile } from 'grammy';
import { startGame } from '../services/game.js';

export const lobbyHandler = new Composer<BotContext>();

async function currentRoom(ctx: BotContext): Promise<R.Room | null> {
  const room = await R.activeRoomOf(ctx.user.id);
  if (!room) {
    await ctx.answerCallbackQuery({ text: 'Комната уже закрыта.', show_alert: true });
    return null;
  }
  return room;
}

async function adminRoom(ctx: BotContext): Promise<R.Room | null> {
  const room = await currentRoom(ctx);
  if (!room) return null;
  if (room.adminUserId !== ctx.user.id) {
    await ctx.answerCallbackQuery({ text: 'Это может только админ комнаты.', show_alert: true });
    return null;
  }
  return room;
}

lobbyHandler.callbackQuery('lb:qr', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  await ctx.answerCallbackQuery();
  const png = await roomQr(room.code);
  await ctx.replyWithPhoto(new InputFile(png, `room-${room.code}.png`), {
    caption: `🐒 Комната <code>${room.code}</code>`,
    parse_mode: 'HTML',
  });
  await openLobbyFor(ctx.api, room.id, ctx.user.id);
});

lobbyHandler.callbackQuery('lb:vote', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const options = RULES.voteEveryOptions;
  const idx = options.indexOf(room.voteEvery as (typeof options)[number]);
  const next = options[(idx + 1) % options.length]!;
  await R.setVoteEvery(room.id, next);
  await R.touchRoom(room.id);
  await ctx.answerCallbackQuery({ text: `Голосование ${voteEveryLabel(next)}` });
  refreshLobbySoon(ctx.api, room.id);
});

lobbyHandler.callbackQuery('lb:code', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  if (room.state === 'playing') {
    await ctx.answerCallbackQuery({ text: 'Идёт игра — код сейчас не поменять.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'custom_code');
  await ctx.reply(renderCodePrompt(MIN_CODE_LEN, MAX_CODE_LEN), { parse_mode: 'HTML' });
});

lobbyHandler.callbackQuery('lb:lock', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const locked = !room.locked;
  await R.setLocked(room.id, locked);
  await ctx.answerCallbackQuery({ text: locked ? '🔒 Вход закрыт' : '🔓 Вход открыт' });
  refreshLobbySoon(ctx.api, room.id);
});

lobbyHandler.callbackQuery('lb:deck', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  await ctx.answerCallbackQuery();
  const list = await decksFor(ctx.user.id);
  const { text, keyboard } = renderDeckPicker({ room, decks: list });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

lobbyHandler.callbackQuery(/^lb:deck:(\d+)$/, async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const deckId = Number(ctx.match![1]);
  const deck = await getDeck(deckId);
  if (!deck) {
    await ctx.answerCallbackQuery({ text: 'Колода не найдена.', show_alert: true });
    return;
  }
  if (!(await ownsDeck(ctx.user.id, deck))) {
    trackDeckLockedHit(ctx.user.id, deck.slug);
    await ctx.answerCallbackQuery({ text: `🔒 «${deck.title}» — платная колода.`, show_alert: true });
    // Ведём в магазин сразу на карточку этой колоды: человек уже выбрал,
    // что хочет, — заставлять его искать это ещё раз незачем.
    await ctx.reply(`🔒 Колода «${deck.title}» пока закрыта.`, {
      reply_markup: new InlineKeyboard().text('🛒 Открыть в магазине', `shop:deck:${deck.id}`),
    });
    return;
  }
  await R.setDeck(room.id, deck.id);
  await R.touchRoom(room.id);
  track({ type: 'deck_selected', userId: ctx.user.id, roomId: room.id, payload: { deckSlug: deck.slug } });
  await ctx.answerCallbackQuery({ text: `Колода: ${deck.title}` });
  await ctx.deleteMessage().catch(() => {});
  await refreshLobby(ctx.api, room.id);
});

lobbyHandler.callbackQuery('lb:back', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

lobbyHandler.callbackQuery('lb:leave', async (ctx) => {
  const room = await currentRoom(ctx);
  if (!room) return;
  if (room.state === 'playing') {
    await ctx.answerCallbackQuery({ text: 'Идёт игра — выйти нельзя.', show_alert: true });
    return;
  }
  await R.leaveRoom(ctx.user.id);
  await ctx.answerCallbackQuery({ text: 'Вышел из комнаты.' });
  await ctx.editMessageText('🚪 Ты вышел из комнаты. /start — вернуться в меню.').catch(() => {});
  refreshLobbySoon(ctx.api, room.id);
});

lobbyHandler.callbackQuery('lb:close', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const members = await R.listMembers(room.id);
  await R.closeRoom(room.id);
  track({ type: 'room_closed', userId: ctx.user.id, roomId: room.id, payload: { reason: 'admin' } });
  await ctx.answerCallbackQuery({ text: 'Комната закрыта.' });
  await closeLobby(ctx.api, room, members, 'Админ закрыл комнату. /start — создать новую.');
});

lobbyHandler.callbackQuery('lb:start', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  if (room.state === 'playing') {
    await ctx.answerCallbackQuery({ text: 'Игра уже идёт.', show_alert: true });
    return;
  }

  const members = await R.listMembers(room.id);
  const check = canStart(members.length);
  if (!check.ok) {
    await ctx.answerCallbackQuery({ text: `⚠️ ${check.reason}`, show_alert: true });
    return;
  }

  const noDm = members.filter((m) => !m.dmOk);
  if (noDm.length) {
    const names = noDm.map((m) => displayName(m.user)).join(', ');
    await ctx.answerCallbackQuery({
      text: `⚠️ Бот не может писать в личку: ${names}.\nПусть нажмут /start у бота.`,
      show_alert: true,
    });
    return;
  }

  if (!room.deckId) {
    await ctx.answerCallbackQuery({ text: '⚠️ Сначала выбери колоду.', show_alert: true });
    return;
  }
  const deck = await getDeck(room.deckId);
  if (!deck || !(await ownsDeck(ctx.user.id, deck))) {
    await ctx.answerCallbackQuery({ text: '⚠️ Эта колода тебе недоступна. Выбери другую.', show_alert: true });
    return;
  }
  const actions = await deckActions(deck.id);
  if (actions.length < RULES.cardSize) {
    await ctx.answerCallbackQuery({
      text: `⚠️ В колоде «${deck.title}» всего ${actions.length} действий, нужно минимум ${RULES.cardSize}.`,
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🎴 Раздаю карточки…' });
  const game = await startGame(ctx.api, room, members, actions, deck.slug);
  if (!game) await ctx.answerCallbackQuery({ text: 'Игра уже идёт.' }).catch(() => {});
});
