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

  /**
   * Ключи касс. Пусто — провайдер просто не поднимается: включить его из
   * панели не выйдет, и это намеренно. Деньги не должны зависеть от того,
   * не промахнулся ли кто-то кнопкой в интерфейсе.
   */
  yookassa: {
    shopId: process.env.YOOKASSA_SHOP_ID ?? '',
    secretKey: process.env.YOOKASSA_SECRET_KEY ?? '',
    /** куда вернуть человека после оплаты — обычно ссылка на самого бота */
    returnUrl: process.env.YOOKASSA_RETURN_URL ?? '',
    /** ставка НДС для чека по 54-ФЗ: 1 — без НДС, см. доку ЮKassa */
    vatCode: Number(process.env.YOOKASSA_VAT_CODE ?? 1),
    /** чек не формируем, если касса подключена без онлайн-кассы */
    sendReceipt: (process.env.YOOKASSA_SEND_RECEIPT ?? 'false') === 'true',
  },
  cryptoBot: {
    token: process.env.CRYPTO_PAY_TOKEN ?? '',
    /** mainnet | testnet */
    net: (process.env.CRYPTO_PAY_NET ?? 'mainnet') as 'mainnet' | 'testnet',
    /** в чём выставляем счёт: USDT надёжнее волатильных монет */
    asset: process.env.CRYPTO_PAY_ASSET ?? 'USDT',
  },
  /**
   * Секрет в пути вебхука. Ни ЮKassa, ни Crypto Pay не подписывают тело так,
   * чтобы это было удобно проверять, поэтому неугадываемый путь — первая
   * линия обороны, а вторая — сверка суммы с заказом.
   */
  webhookPathSecret: process.env.WEBHOOK_PATH_SECRET ?? '',
} as const;

export function deepLink(code: string): string {
  return `https://t.me/${config.botUsername}?start=r_${code}`;
}

/** Пригласительная ссылка. Префикс `ref_` не пересекается с `r_`/`g_`. */
export function referralLink(code: string): string {
  return `https://t.me/${config.botUsername}?start=ref_${code}`;
}
