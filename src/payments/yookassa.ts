import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { payLog } from '../lib/log.js';
import { ProviderError } from './types.js';
import type { Checkout, CheckoutRequest, ProviderAdapter } from './types.js';

/**
 * ЮKassa, REST API v3. Карты РФ и СБП.
 *
 * ⚠️ Для колод внутри бота этот провайдер включать нельзя: правила Telegram
 * требуют, чтобы цифровые товары в боте продавались только за Stars.
 * Он заведён под внешнюю витрину и физические товары — и по умолчанию
 * выключен в настройках.
 */

const API = 'https://api.yookassa.ru/v3';
const TIMEOUT_MS = 15_000;

/** Рубли строкой с двумя знаками — API отвергает и число, и «199». */
const amountValue = (minor: number): string => (minor / 100).toFixed(2);

function authHeader(): string {
  const raw = `${config.yookassa.shopId}:${config.yookassa.secretKey}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotenceKey?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    'Content-Type': 'application/json',
  };
  // Ключ идемпотентности обязателен для POST: без него повтор запроса после
  // сетевого таймаута создаёт второй платёж на ту же сумму.
  if (init.idempotenceKey) headers['Idempotence-Key'] = init.idempotenceKey;

  // Тело запроса — на debug: там суммы и описания, но никаких ключей.
  // Заголовок Authorization не логируем никогда и ни на каком уровне.
  payLog.debug({ provider: 'yookassa', method: init.method, path, body: init.body }, 'запрос в кассу');

  const startedAt = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  const ms = Date.now() - startedAt;

  if (!res.ok) {
    payLog.error({ provider: 'yookassa', status: res.status, path, ms, body: text.slice(0, 500) }, 'ЮKassa: запрос не прошёл');
    throw new ProviderError('yookassa', `ЮKassa ответила ${res.status}`, text.slice(0, 500));
  }
  payLog.debug({ provider: 'yookassa', status: res.status, path, ms, body: text.slice(0, 1000) }, 'ответ кассы');
  return JSON.parse(text) as T;
}

export interface YooPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid: boolean;
  amount: { value: string; currency: string };
  metadata?: Record<string, string>;
  confirmation?: { type: string; confirmation_url?: string };
}

/**
 * Чек по 54-ФЗ. Нужен, только если касса подключена с онлайн-кассой;
 * у самозанятых через ЮKassa чек обычно формирует сама площадка.
 */
function receipt(req: CheckoutRequest) {
  return {
    customer: { email: `tg${req.tgId}@telegram.invalid` },
    items: [
      {
        description: req.title.slice(0, 128),
        quantity: '1.00',
        amount: { value: amountValue(req.amountMinor), currency: 'RUB' },
        vat_code: config.yookassa.vatCode,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      },
    ],
  };
}

export const yookassaProvider: ProviderAdapter = {
  id: 'yookassa',
  title: 'Карта / СБП',
  currency: 'RUB',

  configured: () => Boolean(config.yookassa.shopId && config.yookassa.secretKey),

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    if (!yookassaProvider.configured()) {
      throw new ProviderError('yookassa', 'ЮKassa не настроена: нет shopId или ключа');
    }

    const payment = await call<YooPayment>('/payments', {
      method: 'POST',
      // Ключом берём наш orderId: повторная попытка оформить тот же заказ
      // вернёт тот же платёж, а не создаст второй.
      idempotenceKey: req.orderId,
      body: {
        amount: { value: amountValue(req.amountMinor), currency: 'RUB' },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: config.yookassa.returnUrl || `https://t.me/${config.botUsername}`,
        },
        description: req.description.slice(0, 128),
        // Свой идентификатор кладём в metadata и по нему же ищем заказ,
        // когда придёт уведомление: доверять чему-то ещё из тела нельзя.
        metadata: { orderId: req.orderId, tgId: String(req.tgId) },
        ...(config.yookassa.sendReceipt ? { receipt: receipt(req) } : {}),
      },
    });

    const url = payment.confirmation?.confirmation_url;
    if (!url) throw new ProviderError('yookassa', 'ЮKassa не вернула ссылку на оплату', payment);
    return { kind: 'url', url, externalId: payment.id };
  },
};

/**
 * Перечитать платёж у кассы. Уведомления ЮKassa не подписаны, поэтому телу
 * вебхука мы не верим вообще: берём оттуда только id и спрашиваем статус
 * у API. Подделать уведомление в этой схеме бесполезно.
 */
export async function fetchPayment(id: string): Promise<YooPayment> {
  return call<YooPayment>(`/payments/${encodeURIComponent(id)}`, { method: 'GET' });
}

export async function refund(paymentId: string, amountMinor: number): Promise<void> {
  payLog.warn({ provider: 'yookassa', paymentId, amountMinor }, 'запрашиваю возврат в кассе');
  await call('/refunds', {
    method: 'POST',
    idempotenceKey: randomUUID(),
    body: {
      payment_id: paymentId,
      amount: { value: amountValue(amountMinor), currency: 'RUB' },
    },
  });
}
