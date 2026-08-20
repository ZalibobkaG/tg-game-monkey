import { createServer } from 'node:http';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { COMMANDS, bot } from './bot.js';
import { sql } from './db/index.js';
import { announceRecovery, recoverGames } from './services/game.js';
import { startJanitor } from './services/janitor.js';
import { flush as flushAnalytics } from './services/analytics.js';
import { log } from './lib/log.js';
import { initSentry, flushSentry } from './lib/sentry.js';

async function main(): Promise<void> {
  initSentry();
  await bot.api.setMyCommands(COMMANDS);

  // Состояние партий поднимаем синхронно — это быстро. А вот рассылку
  // «бот перезапустился» шлём фоном уже после старта: полсотни партий
  // по восемь человек — это четыреста правок, они задержали бы приём
  // апдейтов на добрые полминуты.
  const restored = await recoverGames().catch((e) => {
    log.error({ err: e }, 'не удалось восстановить партии');
    return [];
  });
  startJanitor(bot.api);

  if (config.mode === 'webhook') {
    if (!config.webhookUrl) throw new Error('BOT_MODE=webhook, но не задан WEBHOOK_URL');
    const handle = webhookCallback(bot, 'http', { secretToken: config.webhookSecret || undefined });
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/tg') return void handle(req, res);
      res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : '');
    });
    server.listen(config.port, () => log.info({ port: config.port }, '🐒 webhook запущен'));
    void announceRecovery(bot.api, restored);
    await bot.api.setWebhook(config.webhookUrl, {
      secret_token: config.webhookSecret || undefined,
      drop_pending_updates: true,
    });
    shutdown(() => server.close());
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    log.info('🐒 polling запущен');
    shutdown(() => bot.stop());
    void announceRecovery(bot.api, restored);
    await bot.start();
  }
}

function shutdown(stop: () => void): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      log.info({ signal: sig }, 'останавливаюсь');
      stop();
      await flushAnalytics().catch(() => {});
      await flushSentry().catch(() => {});
      await sql.end({ timeout: 5 }).catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log.fatal({ err: e }, 'не удалось запуститься');
  process.exit(1);
});
