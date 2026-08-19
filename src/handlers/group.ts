import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types.js';
import { config } from '../config.js';

export const groupHandler = new Composer<BotContext>();

groupHandler.chatType(['group', 'supergroup']).command('game', async (ctx) => {
  const keyboard = new InlineKeyboard().url(
    '🎲 Создать комнату',
    `https://t.me/${config.botUsername}?start=g_${ctx.chat.id}`,
  );
  await ctx.reply(
    [
      '🐒 <b>Игра «Обезьянка»</b>',
      '',
      'Кто ведущий — жми кнопку. Комната создастся у тебя в личке,',
      'а сюда прилетит код и кнопка входа для остальных.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
});
