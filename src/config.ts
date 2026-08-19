import 'dotenv/config';

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
} as const;

export function deepLink(code: string): string {
  return `https://t.me/${config.botUsername}?start=r_${code}`;
}
