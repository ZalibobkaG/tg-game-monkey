import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { BotContext } from '../types.js';
import * as R from '../repo/rooms.js';
import { looksLikeRoomCode, normalizeRoomCode } from '../lib/code.js';
import { announceInGroup, openLobbyFor, refreshLobby, refreshMany } from '../services/lobby.js';
import { roomQr } from '../services/qr.js';
import * as pending from '../lib/pending.js';
import { RULES_TEXT, WELCOME } from '../ui/texts.js';

export const startHandler = new Composer<BotContext>();

export const menuKeyboard = () =>
  new InlineKeyboard()
    .text('🎲 Создать комнату', 'menu:create')
    .row()
    .text('🔑 Войти по коду', 'menu:join')
    .row()
    .text('📖 Правила', 'menu:rules');

async function sendQr(ctx: BotContext, code: string): Promise<void> {
  const png = await roomQr(code);
  await ctx.replyWithPhoto(new InputFile(png, `room-${code}.png`), {
    caption: `🐒 Комната <code>${code}</code>\nДай отсканировать — или продиктуй код.`,
    parse_mode: 'HTML',
  });
}

export async function createRoomFlow(ctx: BotContext, chatId?: number): Promise<void> {
  const { room, affectedRooms } = await R.createRoom(ctx.user.id, chatId);
  await sendQr(ctx, room.code);
  await openLobbyFor(ctx.api, room.id, ctx.user.id);
  if (chatId) {
    await announceInGroup(ctx.api, room.id, chatId).catch(async () => {
      await ctx.reply('⚠️ Не смог написать в групповой чат — но комната создана, код выше.');
    });
  }
  await refreshMany(ctx.api, affectedRooms);
}

export async function joinByCode(ctx: BotContext, rawCode: string): Promise<void> {
  const code = normalizeRoomCode(rawCode);
  const res = await R.joinRoom(code, ctx.user.id);
  if (!res.ok) {
    const reason: Record<typeof res.error, string> = {
      not_found: 'Комнаты с таким кодом нет. Проверь код.',
      closed: 'Эта комната уже закрыта.',
      in_progress: 'В этой комнате уже идёт игра — дождись конца.',
      full: 'В комнате уже максимум игроков.',
    };
    await ctx.reply(`⚠️ ${reason[res.error]}`, { reply_markup: menuKeyboard() });
    return;
  }
  await openLobbyFor(ctx.api, res.room.id, ctx.user.id);
  await refreshLobby(ctx.api, res.room.id);
  await refreshMany(ctx.api, res.affectedRooms);
}

startHandler.command('start', async (ctx) => {
  const payload = (ctx.match ?? '').trim();

  if (payload.startsWith('r_')) return joinByCode(ctx, payload.slice(2));
  if (payload.startsWith('g_')) {
    const chatId = Number(payload.slice(2));
    return createRoomFlow(ctx, Number.isFinite(chatId) ? chatId : undefined);
  }

  const room = await R.activeRoomOf(ctx.user.id);
  if (room) return openLobbyFor(ctx.api, room.id, ctx.user.id);

  await ctx.reply(WELCOME, { parse_mode: 'HTML', reply_markup: menuKeyboard() });
});

startHandler.command('rules', (ctx) => ctx.reply(RULES_TEXT, { parse_mode: 'HTML' }));

startHandler.command('help', (ctx) =>
  ctx.reply(
    [
      '/start — меню',
      '/rules — правила',
      '/room — вернуться в свою комнату',
      '/leave — выйти из комнаты',
      '/game — создать комнату в групповом чате',
    ].join('\n'),
  ),
);

startHandler.command('room', async (ctx) => {
  const room = await R.activeRoomOf(ctx.user.id);
  if (!room) {
    await ctx.reply('Ты сейчас не в комнате.', { reply_markup: menuKeyboard() });
    return;
  }
  await openLobbyFor(ctx.api, room.id, ctx.user.id);
});

startHandler.command('leave', async (ctx) => {
  const room = await R.activeRoomOf(ctx.user.id);
  if (!room) {
    await ctx.reply('Ты сейчас не в комнате.', { reply_markup: menuKeyboard() });
    return;
  }
  await R.leaveRoom(ctx.user.id);
  await ctx.reply('🚪 Вышел из комнаты.', { reply_markup: menuKeyboard() });
  await refreshLobby(ctx.api, room.id);
});

startHandler.callbackQuery('menu:create', async (ctx) => {
  await ctx.answerCallbackQuery();
  await createRoomFlow(ctx);
});

startHandler.callbackQuery('menu:join', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'room_code');
  await ctx.reply('🔑 Пришли код комнаты — 6 символов, например <code>ABC123</code>.', { parse_mode: 'HTML' });
});

startHandler.callbackQuery('menu:rules', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(RULES_TEXT, { parse_mode: 'HTML' });
});

/** Ввод кода комнаты текстом — либо после кнопки, либо если текст сам похож на код. */
startHandler.on('message:text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const text = ctx.message.text.trim();
  const waiting = pending.take(ctx.user.tgId) === 'room_code';

  if (!waiting && !looksLikeRoomCode(text)) return next();
  if (!looksLikeRoomCode(text)) {
    await ctx.reply('Это не похоже на код. Нужно 6 символов, например <code>ABC123</code>.', { parse_mode: 'HTML' });
    return;
  }
  await joinByCode(ctx, text);
});
