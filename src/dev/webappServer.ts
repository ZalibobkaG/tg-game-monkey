/**
 * Мини-апп без бота.
 *
 * Нужен для вёрстки: поднимает только статику и API, не трогая приём
 * апдейтов. Иначе каждая правка отступа требовала бы перезапуска бота,
 * а на проде — ещё и того, чтобы никто в этот момент не играл.
 *
 * Открывать в обычном браузере: задай WEBAPP_DEV_TG_ID=<свой tg_id>,
 * иначе API не пустит — подписи Telegram у браузера нет.
 *
 *     npm run dev:webapp   →   http://localhost:3000/app
 */
import { createServer } from 'node:http';
import type { Api } from 'grammy';
import { config } from '../config.js';
import { bot } from '../bot.js';
import { handleApi } from '../webapp/api.js';
import { handleStatic } from '../webapp/static.js';
import { log } from '../lib/log.js';

/**
 * WEBAPP_FAKE_TELEGRAM=1 — заглушка вместо Telegram. Партия рассылает
 * карточку и сигнал в личку, поэтому без настоящих чатов игроки вылетают
 * прямо на раздаче, и до игровых экранов не добраться. С заглушкой можно
 * прокликать всю партию из браузера — но карточек в чат, само собой,
 * не придёт.
 */
const fakeApi = {
  sendMessage: () => Promise.resolve({ message_id: Math.floor(Math.random() * 1e6) }),
  editMessageText: () => Promise.resolve({}),
  deleteMessage: () => Promise.resolve(true),
} as unknown as Api;

const api = process.env.WEBAPP_FAKE_TELEGRAM === '1' ? fakeApi : bot.api;

const server = createServer((req, res) => {
  void (async () => {
    if (await handleApi(api, req, res)) return;
    if (await handleStatic(req, res)) return;
    res.writeHead(404).end();
  })();
});

server.listen(config.port, () => {
  log.info({ url: `http://localhost:${config.port}/app` }, '🪟 мини-апп поднят без бота');
  if (!config.webapp.devTgId) {
    log.warn('WEBAPP_DEV_TG_ID не задан — из браузера API ответит 401');
  }
  if (api === fakeApi) log.warn('WEBAPP_FAKE_TELEGRAM=1 — сообщения в Telegram не уходят');
});
