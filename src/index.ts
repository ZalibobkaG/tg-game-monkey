import { createServer } from 'node:http';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { COMMANDS, bot } from './bot.js';
import { sql } from './db/index.js';

async function main(): Promise<void> {
  await bot.api.setMyCommands(COMMANDS);

  if (config.mode === 'webhook') {
    if (!config.webhookUrl) throw new Error('BOT_MODE=webhook, но не задан WEBHOOK_URL');
    const handle = webhookCallback(bot, 'http', { secretToken: config.webhookSecret || undefined });
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/tg') return void handle(req, res);
      res.writeHead(req.url === '/health' ? 200 : 404).end(req.url === '/health' ? 'ok' : '');
    });
    server.listen(config.port, () => console.log(`🐒 webhook на :${config.port}`));
    await bot.api.setWebhook(config.webhookUrl, {
      secret_token: config.webhookSecret || undefined,
      drop_pending_updates: true,
    });
    shutdown(() => server.close());
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log('🐒 polling запущен');
    shutdown(() => bot.stop());
    await bot.start();
  }
}

function shutdown(stop: () => void): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      console.log(`\n${sig} — останавливаюсь`);
      stop();
      await sql.end({ timeout: 5 }).catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error('Не удалось запуститься:', e);
  process.exit(1);
});
