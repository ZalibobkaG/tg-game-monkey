import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { BotContext } from '../types.js';
import * as R from '../repo/rooms.js';
import {
  MAX_CODE_LEN,
  MIN_CODE_LEN,
  codeErrorText,
  looksLikeJoinInput,
  normalizeRoomCode,
  validateCustomCode,
} from '../lib/code.js';
import { announceInGroup, openLobbyFor, refreshLobby, refreshMany } from '../services/lobby.js';
import { roomQr } from '../services/qr.js';
import * as pending from '../lib/pending.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { RULES_TEXT, WELCOME } from '../ui/texts.js';
import { handleInvite } from '../services/referral.js';
import { COIN, coins } from '../domain/economy.js';
import { bumpRoomsCreated } from '../repo/gameStats.js';
import { track, trackRoomCreated, trackRoomJoinFailed, trackRoomJoined, trackUserStart } from '../services/analytics.js';
import { log } from '../lib/log.js';

export const startHandler = new Composer<BotContext>();

/**
 * Перебор кодов. Сгенерированный код из 30-символьного алфавита не подобрать,
 * а вот «свой» короткий — вполне, поэтому попытки входа считаем.
 */
const joinLimiter = createRateLimiter(10, 60_000);

export const menuKeyboard = () =>
  new InlineKeyboard()
    .text('🎲 Создать комнату', 'menu:create')
    .row()
    .text('🔑 Войти по коду', 'menu:join')
    .row()
    .text('📖 Правила', 'menu:rules')
    .text('📊 Статистика', 'menu:stats')
    .row()
    .text('🛒 Магазин', 'menu:shop')
    .text('🎁 Пригласить', 'menu:invite')
    .row()
    .text('💡 Написать разработчикам', 'fb:new');

async function sendQr(ctx: BotContext, code: string): Promise<void> {
  const png = await roomQr(code);
  await ctx.replyWithPhoto(new InputFile(png, `room-${code}.png`), {
    caption: `🐒 Комната <code>${code}</code>\nДай отсканировать — или продиктуй код.`,
    parse_mode: 'HTML',
  });
}

export async function createRoomFlow(ctx: BotContext, chatId?: number): Promise<void> {
  const { room, affectedRooms } = await R.createRoom(ctx.user.id, chatId);
  trackRoomCreated(ctx.user.id, room.id, Boolean(chatId), false);
  await bumpRoomsCreated(ctx.user.id).catch((e) => log.error({ err: e }, 'счётчик созданных комнат'));
  await sendQr(ctx, room.code);
  await openLobbyFor(ctx.api, room.id, ctx.user.id);
  if (chatId) {
    await announceInGroup(ctx.api, room.id, chatId).catch(async () => {
      await ctx.reply('⚠️ Не смог написать в групповой чат — но комната создана, код выше.');
    });
  }
  refreshMany(ctx.api, affectedRooms);
}

export async function joinByCode(ctx: BotContext, rawCode: string, via = 'code'): Promise<void> {
  if (!joinLimiter.take(ctx.user.tgId)) {
    await ctx.reply('⏳ Слишком много попыток. Подожди минуту.');
    return;
  }

  const code = normalizeRoomCode(rawCode);
  const res = await R.joinRoom(code, ctx.user.id);
  if (!res.ok) {
    const reason: Record<R.JoinError, string> = {
      not_found: 'Комнаты с таким кодом нет. Проверь код.',
      closed: 'Эта комната уже закрыта.',
      in_progress: 'В этой комнате уже идёт игра — дождись конца.',
      full: 'В комнате уже максимум игроков.',
      locked: 'Админ закрыл вход в эту комнату.',
    };
    trackRoomJoinFailed(ctx.user.id, code, res.error);
    await ctx.reply(`⚠️ ${reason[res.error]}`, { reply_markup: menuKeyboard() });
    return;
  }
  if (!res.alreadyIn) trackRoomJoined(ctx.user.id, res.room.id, via);
  await R.touchRoom(res.room.id);
  await openLobbyFor(ctx.api, res.room.id, ctx.user.id);
  refreshMany(ctx.api, [res.room.id, ...res.affectedRooms]);
}

/** Смена кода комнаты на свой. Вызывается из обработчика текста после кнопки «Свой код». */
async function applyCustomCode(ctx: BotContext, raw: string): Promise<void> {
  const room = await R.activeRoomOf(ctx.user.id);
  if (!room) {
    await ctx.reply('Комната уже закрыта.', { reply_markup: menuKeyboard() });
    return;
  }
  if (room.adminUserId !== ctx.user.id) {
    await ctx.reply('Код меняет только админ комнаты.');
    return;
  }
  if (room.state === 'playing') {
    await ctx.reply('🎬 Идёт игра — код сейчас не поменять.');
    return;
  }

  const parsed = validateCustomCode(raw);
  if (!parsed.ok) {
    await ctx.reply(`⚠️ ${codeErrorText(parsed.reason)}`, { parse_mode: 'HTML' });
    pending.expect(ctx.user.tgId, 'custom_code');
    return;
  }
  if (parsed.code === room.code) {
    await ctx.reply('Это и есть текущий код комнаты.');
    return;
  }

  // Гонку за один и тот же код разруливает уникальный индекс, а не проверка заранее.
  const res = await R.setRoomCode(room.id, parsed.code);
  if (!res.ok) {
    await ctx.reply('⚠️ Такой код уже занят живой комнатой. Придумай другой.');
    pending.expect(ctx.user.tgId, 'custom_code');
    return;
  }

  await ctx.reply(
    `✅ Код комнаты теперь <code>${parsed.code}</code>.\n<i>Старый QR и старая ссылка больше не работают.</i>`,
    { parse_mode: 'HTML' },
  );
  track({
    type: 'room_code_changed',
    userId: ctx.user.id,
    roomId: room.id,
    payload: { from: room.code, to: parsed.code },
  });
  await sendQr(ctx, parsed.code);
  await refreshLobby(ctx.api, room.id);
  await openLobbyFor(ctx.api, room.id, ctx.user.id);
}

startHandler.command('start', async (ctx) => {
  const payload = (ctx.match ?? '').trim();
  pending.clear(ctx.user.tgId);

  // Приглашение проверяем первым: `ref_` и `r_` не пересекаются, но
  // порядок здесь важнее сообразительности читателя.
  if (payload.startsWith('ref_')) {
    trackUserStart(ctx.user.id, 'deeplink_ref');
    const outcome = await handleInvite(ctx.user.id, payload.slice(4).toUpperCase());
    const greeting = outcome.bonus > 0
      ? `${WELCOME}\n\n🎁 <b>Тебе начислено ${coins(outcome.bonus)} ${COIN}</b> за приход по приглашению.`
      : WELCOME;
    await ctx.reply(greeting, { parse_mode: 'HTML', reply_markup: menuKeyboard() });
    return;
  }

  if (payload.startsWith('r_')) {
    trackUserStart(ctx.user.id, 'deeplink_room');
    return joinByCode(ctx, payload.slice(2), 'deeplink');
  }

  if (payload.startsWith('g_')) {
    const chatId = Number(payload.slice(2));
    if (!Number.isFinite(chatId)) return createRoomFlow(ctx);
    // Ссылку легко подделать, подставив чужой chat_id. Без этой проверки бота
    // можно заставить опубликовать анонс в группе, к которой человек непричастен.
    const member = await ctx.api.getChatMember(chatId, ctx.user.tgId).catch(() => null);
    const inChat = member !== null && member.status !== 'left' && member.status !== 'kicked';
    return createRoomFlow(ctx, inChat ? chatId : undefined);
  }

  const room = await R.activeRoomOf(ctx.user.id);
  if (room) return openLobbyFor(ctx.api, room.id, ctx.user.id);

  trackUserStart(ctx.user.id, 'direct');
  await ctx.reply(WELCOME, { parse_mode: 'HTML', reply_markup: menuKeyboard() });
});

startHandler.command('rules', (ctx) => ctx.reply(RULES_TEXT, { parse_mode: 'HTML' }));

startHandler.command('cancel', async (ctx) => {
  pending.clear(ctx.user.tgId);
  await ctx.reply('Отменил.');
});

startHandler.command('help', (ctx) =>
  ctx.reply(
    [
      '/start — меню',
      '/rules — правила',
      '/room — вернуться в свою комнату',
      '/leave — выйти из комнаты',
      '/stats — моя статистика',
      '/shop — магазин колод',
      '/balance — мой счёт',
      '/invite — пригласить друзей',
      '/paysupport — вопросы по оплате',
      '/feedback — написать разработчикам',
      '/privacy — что бот хранит',
      '/cancel — отменить ввод',
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
  if (room.state === 'playing') {
    await ctx.reply('🎬 Идёт игра — дождись конца или попроси админа завершить её.');
    return;
  }
  await R.leaveRoom(ctx.user.id);
  await ctx.reply('🚪 Вышел из комнаты.', { reply_markup: menuKeyboard() });
  refreshMany(ctx.api, [room.id]);
});

startHandler.callbackQuery('menu:create', async (ctx) => {
  await ctx.answerCallbackQuery();
  await createRoomFlow(ctx);
});

startHandler.callbackQuery('menu:join', async (ctx) => {
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'room_code');
  await ctx.reply(
    [
      '🔑 <b>Вход в комнату</b>',
      '',
      'Пришли код, который дал ведущий — слово или набор символов,',
      `например <code>MONKEY</code>.`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});

startHandler.callbackQuery('menu:rules', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(RULES_TEXT, { parse_mode: 'HTML' });
});

/**
 * Текст в личке. Либо мы явно ждём ввод (код комнаты / свой код),
 * либо проверяем в базе, не является ли сообщение кодом живой комнаты.
 *
 * Раньше кодом считался любой текст из шести подходящих символов. С кодами
 * произвольной длины эвристика ломается, поэтому решает не форма, а база:
 * не нашли комнату — молча пропускаем сообщение дальше.
 */
startHandler.on('message:text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const text = ctx.message.text.trim();
  const waiting = pending.peek(ctx.user.tgId);

  // ждут не нас (например, текст обращения) — пропускаем дальше по цепочке
  if (waiting && waiting.kind !== 'room_code' && waiting.kind !== 'custom_code') return next();

  if (waiting?.kind === 'custom_code') {
    pending.clear(ctx.user.tgId);
    return applyCustomCode(ctx, text);
  }

  if (waiting?.kind === 'room_code') {
    pending.clear(ctx.user.tgId);
    if (!looksLikeJoinInput(text)) {
      pending.expect(ctx.user.tgId, 'room_code');
      await ctx.reply(
        `Это не похоже на код. Нужно ${MIN_CODE_LEN}–${MAX_CODE_LEN} латинских букв и цифр, ` +
          'например <code>MONKEY</code>.\n/cancel — отменить.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    return joinByCode(ctx, text);
  }

  if (!looksLikeJoinInput(text)) return next();
  const room = await R.getActiveRoomByCode(normalizeRoomCode(text));
  if (!room) return next();
  return joinByCode(ctx, text);
});
