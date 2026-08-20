import { Bot, GrammyError, HttpError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { config } from './config.js';
import type { BotContext } from './types.js';
import { upsertUser } from './repo/users.js';
import { startHandler } from './handlers/start.js';
import { lobbyHandler } from './handlers/lobby.js';
import { groupHandler } from './handlers/group.js';
import { gameHandler } from './handlers/game.js';
import { adminHandler } from './handlers/admin.js';
import { feedbackHandler } from './handlers/feedback.js';
import { profileHandler } from './handlers/profile.js';
import { log } from './lib/log.js';
import { captureError } from './lib/sentry.js';

export const bot = new Bot<BotContext>(config.botToken);

// Очередь под лимиты Telegram + автоповтор на 429/5xx.
// Без них синхронная рассылка на всю комнату разваливается.
// Дефолтный per-chat лимит 1 msg/sec задушил бы отсчёт 3-2-1 —
// поднимаем до 5/сек в один чат, глобальные 30/сек оставляем как есть.
bot.api.config.use(
  apiThrottler({
    out: {
      maxConcurrent: 1,
      minTime: 200,
      reservoir: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 1000,
    },
  }),
);
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

bot.use(async (ctx, next) => {
  // Входящий текст на уровне debug. Держим включаемым, а не удаляем:
  // именно отсутствие reply_to и тип чата однажды объяснили «бот молчит».
  const m = ctx.message;
  if (m && 'text' in m) {
    const src = m.reply_to_message;
    log.debug(
      { chat: ctx.chat?.type, from: ctx.from?.id, replyTo: src?.from?.id ?? null },
      'входящий текст',
    );
  }

  if (ctx.from && !ctx.from.is_bot) {
    ctx.user = await upsertUser(ctx.from);
    // Забаненного дальше не пускаем: ни команд, ни кнопок.
    if (ctx.user.bannedUntil && ctx.user.bannedUntil > new Date()) {
      log.info({ tgId: ctx.from.id, until: ctx.user.bannedUntil }, 'апдейт от забаненного отброшен');
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Доступ ограничен.', show_alert: true }).catch(() => {});
      }
      return;
    }
  }
  await next();
});

// Порядок важен: обработчики со своим `message:text` идут раньше startHandler,
// который на любой неопознанный текст пробует найти комнату по коду.
bot.use(groupHandler);
bot.use(adminHandler);
bot.use(feedbackHandler);
bot.use(gameHandler);
bot.use(lobbyHandler);
bot.use(profileHandler);
bot.use(startHandler);

bot.catch(async (err) => {
  const { ctx } = err;
  const e = err.error;
  const base = { updateId: ctx.update.update_id, tgId: ctx.from?.id, chat: ctx.chat?.type };

  if (e instanceof GrammyError) {
    log.error({ ...base, code: e.error_code, method: e.method }, `Telegram API: ${e.description}`);
  } else if (e instanceof HttpError) {
    log.error({ ...base, err: e }, 'сеть недоступна');
  } else {
    log.error({ ...base, err: e }, 'необработанная ошибка');
  }
  captureError(e, base);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: 'Что-то пошло не так. Попробуй ещё раз.' }).catch(() => {});
  }
});

export const COMMANDS = [
  { command: 'start', description: 'меню' },
  { command: 'room', description: 'вернуться в комнату' },
  { command: 'rules', description: 'правила' },
  { command: 'leave', description: 'выйти из комнаты' },
  { command: 'stats', description: 'моя статистика' },
  { command: 'feedback', description: 'написать разработчикам' },
  { command: 'help', description: 'помощь' },
];
