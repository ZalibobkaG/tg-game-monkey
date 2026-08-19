import { Bot, GrammyError, HttpError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { config } from './config.js';
import type { BotContext } from './types.js';
import { upsertUser } from './repo/users.js';
import { startHandler } from './handlers/start.js';
import { lobbyHandler } from './handlers/lobby.js';
import { groupHandler } from './handlers/group.js';

export const bot = new Bot<BotContext>(config.botToken);

// Очередь под лимиты Telegram + автоповтор на 429/5xx.
// Без них синхронная рассылка на всю комнату разваливается.
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    ctx.user = await upsertUser(ctx.from);
  }
  await next();
});

bot.use(groupHandler);
bot.use(lobbyHandler);
bot.use(startHandler);

bot.catch(async (err) => {
  const { ctx } = err;
  const e = err.error;
  const where = ctx.update.update_id;
  if (e instanceof GrammyError) {
    console.error(`[${where}] Telegram API ${e.error_code}: ${e.description}`);
  } else if (e instanceof HttpError) {
    console.error(`[${where}] сеть:`, e);
  } else {
    console.error(`[${where}] ошибка:`, e);
  }
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: 'Что-то пошло не так. Попробуй ещё раз.' }).catch(() => {});
  }
});

export const COMMANDS = [
  { command: 'start', description: 'меню' },
  { command: 'room', description: 'вернуться в комнату' },
  { command: 'rules', description: 'правила' },
  { command: 'leave', description: 'выйти из комнаты' },
  { command: 'help', description: 'помощь' },
];
