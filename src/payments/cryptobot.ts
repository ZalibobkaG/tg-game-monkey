import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { payLog } from '../lib/log.js';
import { ProviderError } from './types.js';
import type { Checkout, CheckoutRequest, ProviderAdapter } from './types.js';

/**
 * Crypto Pay API (@CryptoBot) — приём USDT/TON/BTC прямо в Telegram.
 *
 * ⚠️ С точки зрения правил Telegram это такая же сторонняя касса, как ЮKassa:
 * для цифровых товаров внутри бота использовать её нельзя. Заведена под
 * внешнюю витрину и по умолчанию выключена.
 *
 * Счёт выставляем в рублях (`currency_type: fiat`), а платит человек криптой
 * по текущему курсу: так витрина и касса показывают одну и ту же цену,
 * и нам не нужно самим следить за курсом.
 */

const TIMEOUT_MS = 15_000;

const api = (): string =>
  config.cryptoBot.net === 'testnet' ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';

interface CryptoResponse<T> {
  ok: boolean;
  result?: T;
  error?: unknown;
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  // Токен уходит только в заголовке и в лог не попадает.
  payLog.debug({ provider: 'cryptobot', method, body }, 'запрос в Crypto Pay');
  const startedAt = Date.now();

  const res = await fetch(`${api()}/${method}`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': config.cryptoBot.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  const ms = Date.now() - startedAt;
  const parsed = JSON.parse(text) as CryptoResponse<T>;

  if (!res.ok || !parsed.ok || parsed.result === undefined) {
    payLog.error({ provider: 'cryptobot', status: res.status, method, ms, body: text.slice(0, 500) }, 'Crypto Pay: запрос не прошёл');
    throw new ProviderError('cryptobot', `Crypto Pay ответил ${res.status}`, parsed.error ?? text.slice(0, 500));
  }
  payLog.debug({ provider: 'cryptobot', status: res.status, method, ms, body: text.slice(0, 1000) }, 'ответ Crypto Pay');
  return parsed.result;
}

export interface CryptoInvoice {
  invoice_id: number;
  status: 'active' | 'paid' | 'expired';
  bot_invoice_url: string;
  payload?: string;
  amount: string;
  asset?: string;
}

/** Счёт живёт час: дальше курс уезжает настолько, что оплата теряет смысл. */
const INVOICE_TTL_SEC = 3600;

export const cryptoBotProvider: ProviderAdapter = {
  id: 'cryptobot',
  title: 'Крипта (USDT, TON, BTC)',
  currency: 'RUB',

  configured: () => Boolean(config.cryptoBot.token),

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    if (!cryptoBotProvider.configured()) {
      throw new ProviderError('cryptobot', 'Crypto Pay не настроен: нет токена');
    }

    const invoice = await call<CryptoInvoice>('createInvoice', {
      currency_type: 'fiat',
      fiat: 'RUB',
      amount: (req.amountMinor / 100).toFixed(2),
      accepted_assets: config.cryptoBot.asset,
      description: req.description.slice(0, 1024),
      // payload возвращается в вебхуке нетронутым — по нему находим заказ
      payload: req.orderId,
      paid_btn_name: 'callback',
      paid_btn_url: `https://t.me/${config.botUsername}`,
      expires_in: INVOICE_TTL_SEC,
      allow_comments: false,
      allow_anonymous: false,
    });

    return { kind: 'url', url: invoice.bot_invoice_url, externalId: String(invoice.invoice_id) };
  },
};

export async function fetchInvoice(invoiceId: string): Promise<CryptoInvoice | undefined> {
  const res = await call<{ items: CryptoInvoice[] }>('getInvoices', { invoice_ids: invoiceId });
  return res.items[0];
}

/**
 * Проверка подписи вебхука. Ключ — SHA-256 от токена, подпись — HMAC-SHA256
 * от сырого тела. Сравнение обязательно постоянное по времени: обычное `===`
 * на строках утекает информацию о том, сколько байт подписи угадано.
 */
export function verifySignature(rawBody: string, signature: string): boolean {
  if (!signature || !config.cryptoBot.token) return false;

  const secret = createHash('sha256').update(config.cryptoBot.token).digest();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
