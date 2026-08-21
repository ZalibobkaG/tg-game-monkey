import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from 'grammy';
import { config } from '../config.js';
import { settle } from '../services/purchase.js';
import * as P from '../repo/payments.js';
import { fetchPayment } from '../payments/yookassa.js';
import { verifySignature } from '../payments/cryptobot.js';
import { payLog } from '../lib/log.js';

/**
 * Уведомления внешних касс.
 *
 * Общее правило: телу уведомления не верим. У ЮKassa подписи нет вовсе,
 * поэтому берём оттуда только id и перечитываем платёж через API; у Crypto
 * Pay подпись есть — проверяем её. Плюс к этому путь содержит секрет,
 * а сумма сверяется с заказом.
 */

/** Больше мегабайта в уведомлении о платеже не бывает — дальше это уже атака. */
const MAX_BODY = 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('тело запроса не пришло вовремя')), BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error('тело запроса слишком большое'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Секрет в пути. Сравнение посимвольное по всей длине: путь приходит из
 * сети, и утечка по времени здесь так же реальна, как в подписи.
 */
function pathSecretOk(actual: string): boolean {
  const expected = config.webhookPathSecret;
  if (!expected) return false;
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface YooNotification {
  event?: string;
  object?: { id?: string; metadata?: Record<string, string> };
}

/**
 * ЮKassa. Из уведомления берём только id платежа и спрашиваем его статус
 * у API: подделать такое уведомление бессмысленно — чужой id либо не
 * найдётся, либо окажется неоплаченным.
 */
async function handleYookassa(api: Api, raw: string): Promise<number> {
  const body = JSON.parse(raw) as YooNotification;
  const id = body.object?.id;
  payLog.info({ provider: 'yookassa', event: body.event, id: id ?? null }, 'уведомление от кассы');
  payLog.debug({ provider: 'yookassa', raw: raw.slice(0, 2000) }, 'тело уведомления');
  if (!id) return 400;

  const payment = await fetchPayment(id);
  const orderId = payment.metadata?.['orderId'];
  if (!orderId) {
    payLog.warn({ provider: 'yookassa', id }, 'в платеже нет orderId — не наш платёж');
    return 200;
  }

  if (payment.status === 'canceled') {
    payLog.info({ provider: 'yookassa', orderId, id }, 'платёж отменён');
    await P.markFailed(orderId, 'canceled', { yookassaId: id });
    return 200;
  }
  if (payment.status !== 'succeeded' || !payment.paid) {
    payLog.info({ provider: 'yookassa', orderId, id, status: payment.status, paid: payment.paid }, 'платёж ещё не проведён');
    return 200;
  }

  // Сумма из кассы должна совпасть с заказом: иначе оплатить дешёвую
  // колоду и получить дорогую было бы вопросом подмены одного поля.
  const order = await P.byOrderId(orderId);
  if (!order) {
    payLog.warn({ provider: 'yookassa', orderId, id }, 'заказ не найден');
    return 200;
  }
  const paidMinor = Math.round(Number(payment.amount.value) * 100);
  if (paidMinor !== order.amountMinor || payment.amount.currency !== order.currency) {
    payLog.error(
      { provider: 'yookassa', orderId, expected: order.amountMinor, got: paidMinor, currency: payment.amount.currency },
      'сумма платежа не совпала с заказом — не выдаю',
    );
    return 200;
  }

  await settle(api, { orderId, externalId: id, metadata: { yookassa: payment.status } });
  return 200;
}

interface CryptoUpdate {
  update_type?: string;
  payload?: { invoice_id?: number; status?: string; payload?: string; amount?: string };
}

/** Crypto Pay подписывает тело — проверяем подпись и только потом верим payload. */
async function handleCrypto(api: Api, raw: string, signature: string): Promise<number> {
  if (!verifySignature(raw, signature)) {
    payLog.warn({ provider: 'cryptobot' }, 'подпись не сошлась');
    return 403;
  }

  const body = JSON.parse(raw) as CryptoUpdate;
  payLog.info({ provider: 'cryptobot', event: body.update_type, invoiceId: body.payload?.invoice_id ?? null }, 'уведомление от Crypto Pay');
  payLog.debug({ provider: 'cryptobot', raw: raw.slice(0, 2000) }, 'тело уведомления');

  if (body.update_type !== 'invoice_paid') return 200;

  const orderId = body.payload?.payload;
  const invoiceId = body.payload?.invoice_id;
  if (!orderId) {
    payLog.warn({ provider: 'cryptobot', invoiceId }, 'в счёте нет нашего orderId');
    return 200;
  }

  await settle(api, {
    orderId,
    externalId: invoiceId ? String(invoiceId) : null,
    metadata: { cryptoInvoice: invoiceId },
  });
  return 200;
}

/**
 * Роутер платёжных уведомлений. Возвращает true, если запрос — наш:
 * иначе вызывающий отдаёт его дальше (телеграмному вебхуку или 404).
 */
export async function handlePaymentWebhook(
  api: Api,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '';
  if (!url.startsWith('/pay/')) return false;

  const [, , provider = '', secret = ''] = url.split('?')[0]!.split('/');

  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return true;
  }
  if (!pathSecretOk(secret)) {
    // Секрет в лог не пишем даже неверный: в журнал попадёт то, что кто-то
    // подбирает, а рядом — верный, и вместе они складываются в подсказку.
    payLog.warn({ provider }, 'платёжный вебхук с неверным секретом в пути');
    res.writeHead(404).end();
    return true;
  }

  const startedAt = Date.now();
  let status = 500;
  try {
    const raw = await readBody(req);
    if (provider === 'yookassa') {
      status = await handleYookassa(api, raw);
    } else if (provider === 'crypto') {
      status = await handleCrypto(api, raw, String(req.headers['crypto-pay-api-signature'] ?? ''));
    } else {
      status = 404;
    }
  } catch (e) {
    // 500 здесь — не поражение: и ЮKassa, и Crypto Pay повторят уведомление,
    // а выдать товар дважды нам не даст условный UPDATE в markPaid.
    payLog.error({ err: e, provider }, 'платёжный вебхук упал');
    status = 500;
  }

  payLog.info({ provider, status, ms: Date.now() - startedAt }, 'вебхук обработан');
  res.writeHead(status).end();
  return true;
}

/** Настроен ли приём уведомлений — по этому решаем, поднимать ли сервер в polling-режиме. */
export function paymentWebhooksEnabled(): boolean {
  return Boolean(
    config.webhookPathSecret && (config.yookassa.shopId || config.cryptoBot.token),
  );
}

/** Пути, которые нужно прописать в личных кабинетах касс. */
export function webhookPaths(): { yookassa: string; crypto: string } {
  return {
    yookassa: `/pay/yookassa/${config.webhookPathSecret}`,
    crypto: `/pay/crypto/${config.webhookPathSecret}`,
  };
}
