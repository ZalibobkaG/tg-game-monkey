/**
 * Проверка доступа к платёжным вебхукам.
 *
 * Отдельным процессом, потому что секреты читаются из окружения один раз при
 * импорте `config`. Запускается из `checkSecurity.ts` с подставными ключами:
 * без них все запросы отвергались бы просто потому, что приём выключен, —
 * и проверка ничего бы не значила.
 */
import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from 'grammy';
import { config } from '../config.js';
import { handlePaymentWebhook } from '../http/webhooks.js';
import { sql as pg } from '../db/index.js';

let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const fakeApi = { sendMessage: () => Promise.resolve({}) } as unknown as Api;
const SECRET = config.webhookPathSecret;

function req(url: string, body: string, headers: Record<string, string> = {}, method = 'POST'): IncomingMessage {
  const r = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  r.url = url;
  r.method = method;
  r.headers = headers;
  return r;
}

async function hit(
  url: string,
  body = '{}',
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ handled: boolean; status: number | null }> {
  let status: number | null = null;
  const res = {
    writeHead(c: number) { status = c; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  const handled = await handlePaymentWebhook(fakeApi, req(url, body, headers, method), res);
  return { handled, status };
}

/** Подпись Crypto Pay: HMAC-SHA256 телом, ключ — SHA-256 от токена приложения. */
function sign(body: string): string {
  const secret = createHash('sha256').update(config.cryptoBot.token).digest();
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error('запускать только с заданным WEBHOOK_PATH_SECRET');

  // ── положительный контроль ─────────────────────────────────────────────
  // Верный секрет ДОЛЖЕН пропускать дальше. Без этой проверки все остальные
  // ничего не стоят: 404 на всё подряд выдал бы и полностью сломанный роутер.
  const good = await hit(`/pay/yookassa/${SECRET}`, '{}');
  ok('верный секрет пропускает к обработчику (400 на пустое тело)', good.status === 400, good);

  const goodCrypto = await hit(
    `/pay/crypto/${SECRET}`,
    JSON.stringify({ update_type: 'other' }),
    { 'crypto-pay-api-signature': sign(JSON.stringify({ update_type: 'other' })) },
  );
  ok('верная подпись Crypto Pay пропускает', goodCrypto.status === 200, goodCrypto);

  // ── отрицательные ──────────────────────────────────────────────────────
  const flipped = SECRET.slice(0, -1) + (SECRET.at(-1) === 'a' ? 'b' : 'a');
  const cases: Array<[string, Promise<{ status: number | null }>, number]> = [
    ['секрет с одним изменённым символом', hit(`/pay/yookassa/${flipped}`), 404],
    ['секрет длиннее на символ', hit(`/pay/yookassa/${SECRET}x`), 404],
    ['секрет короче на символ', hit(`/pay/yookassa/${SECRET.slice(0, -1)}`), 404],
    ['пустой секрет', hit('/pay/yookassa/'), 404],
    ['секрет в query вместо пути', hit(`/pay/yookassa/x?secret=${SECRET}`), 404],
    ['GET вместо POST', hit(`/pay/yookassa/${SECRET}`, '{}', {}, 'GET'), 405],
    ['неизвестный провайдер с верным секретом', hit(`/pay/sberbank/${SECRET}`), 404],
  ];
  for (const [name, promise, expected] of cases) {
    const r = await promise;
    ok(`${name} → ${expected}`, r.status === expected, r.status);
  }

  // Подпись обязательна даже при верном секрете в пути.
  const body = JSON.stringify({ update_type: 'invoice_paid', payload: { invoice_id: 1, payload: 'o-чужой' } });
  const noSig = await hit(`/pay/crypto/${SECRET}`, body);
  ok('Crypto Pay без подписи → 403', noSig.status === 403, noSig);

  const wrongSig = await hit(`/pay/crypto/${SECRET}`, body, { 'crypto-pay-api-signature': sign(body + 'x') });
  ok('Crypto Pay с подписью от другого тела → 403', wrongSig.status === 403, wrongSig);

  // Подмена суммы в подписанном теле ломает подпись — это и требуется.
  const tampered = body.replace('"invoice_id":1', '"invoice_id":999');
  const tamperedRes = await hit(`/pay/crypto/${SECRET}`, tampered, { 'crypto-pay-api-signature': sign(body) });
  ok('правка подписанного тела → 403', tamperedRes.status === 403, tamperedRes);

  // Гигантское тело не должно съесть память процесса.
  const huge = await hit(`/pay/yookassa/${SECRET}`, 'x'.repeat(2 * 1024 * 1024));
  ok('переразмерное тело отвергнуто', huge.status === 500, huge);

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '✅ доступ к вебхукам в порядке');
  await pg.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pg.end();
  process.exit(1);
});
