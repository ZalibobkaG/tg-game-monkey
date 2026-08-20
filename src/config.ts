import 'dotenv/config';
import type pino from 'pino';

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return v.trim();
}

export const config = {
  botToken: required('BOT_TOKEN'),
  /** без @ — используется в deep-link и QR */
  botUsername: required('BOT_USERNAME').replace(/^@/, ''),
  databaseUrl: required('DATABASE_URL'),
  mode: (process.env.BOT_MODE ?? 'polling') as 'polling' | 'webhook',
  webhookUrl: process.env.WEBHOOK_URL ?? '',
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  port: Number(process.env.PORT ?? 3000),
  /** бутстрап-владельцы панели: tg_id через запятую. Остальных админов назначают из панели */
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  /** служебный чат для обращений: несколько админов видят одно и то же и не дублируют ответы */
  adminChatId: Number(process.env.ADMIN_CHAT_ID ?? 0) || null,
  logLevel: (process.env.LOG_LEVEL ?? 'info') as pino.Level,
  /** пусто — Sentry не поднимается, ошибки остаются только в логе */
  sentryDsn: process.env.SENTRY_DSN ?? '',
} as const;

export function deepLink(code: string): string {
  return `https://t.me/${config.botUsername}?start=r_${code}`;
}
