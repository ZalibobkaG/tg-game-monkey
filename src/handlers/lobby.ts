import { Composer } from 'grammy';
import type { BotContext } from '../types.js';
import * as R from '../repo/rooms.js';
import { deckActions, decksFor, getDeck, ownsDeck } from '../repo/decks.js';
import { RULES, canStart } from '../domain/rules.js';
import { closeLobby, openLobbyFor, refreshLobby } from '../services/lobby.js';
import { renderDeckPicker } from '../ui/lobby.js';
import { roomQr } from '../services/qr.js';
import { displayName } from '../repo/users.js';
import { InputFile } from 'grammy';

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

lobbyHandler.callbackQuery('lb:rounds', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const options = RULES.roundsOptions;
  const idx = options.indexOf(room.roundsCount as (typeof options)[number]);
  const next = options[(idx + 1) % options.length]!;
  await R.setRounds(room.id, next);
  await ctx.answerCallbackQuery({ text: `Раундов: ${next}` });
  await refreshLobby(ctx.api, room.id);
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
    await ctx.answerCallbackQuery({
      text: `🔒 «${deck.title}» — платная колода, ${deck.priceRub} ₽.\nМагазин появится в ближайшем обновлении.`,
      show_alert: true,
    });
    return;
  }
  await R.setDeck(room.id, deck.id);
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
  await R.leaveRoom(ctx.user.id);
  await ctx.answerCallbackQuery({ text: 'Вышел из комнаты.' });
  await ctx.editMessageText('🚪 Ты вышел из комнаты. /start — вернуться в меню.').catch(() => {});
  await refreshLobby(ctx.api, room.id);
});

lobbyHandler.callbackQuery('lb:close', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;
  const members = await R.listMembers(room.id);
  await R.closeRoom(room.id);
  await ctx.answerCallbackQuery({ text: 'Комната закрыта.' });
  await closeLobby(ctx.api, room, members, 'Админ закрыл комнату. /start — создать новую.');
});

lobbyHandler.callbackQuery('lb:start', async (ctx) => {
  const room = await adminRoom(ctx);
  if (!room) return;

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

  await ctx.answerCallbackQuery({
    text: '✅ Всё готово к старту.\n\nРаздача карточек и раунды — следующий этап разработки.',
    show_alert: true,
  });
});
