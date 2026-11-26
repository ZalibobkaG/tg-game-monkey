/**
 * Проверка входа в мини-апп.
 *
 * Мини-апп — единственное место, где к нам приходят запросы не от Telegram,
 * а из браузера, и вся его безопасность держится на одной подписи. Поэтому
 * бьём по `verifyInitData` тем, чем по нему будут бить: чужой подписью,
 * подменённым id, просроченной датой, лишними полями.
 *
 *     npm run check:webapp
 */
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { verifyInitData } from '../webapp/auth.js';

let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

/** Собирает initData ровно так, как это делает Telegram. */
function sign(fields: Record<string, string>, token = config.botToken): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');

  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

const user = (id: number) => JSON.stringify({ id, first_name: 'Тест', username: 'tester' });
const now = () => String(Math.floor(Date.now() / 1000));

/**
 * Поля, которые реально шлёт современный клиент. Важен здесь `signature`:
 * подписывать голый набор из `auth_date` и `user` — значит проверять код
 * им же самим и не заметить, что в живой строке полей больше.
 */
const realistic = (): Record<string, string> => ({
  auth_date: now(),
  chat_instance: '-1234567890123456789',
  chat_type: 'private',
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  signature: 'Ck9Xz1Q0v_KpxT2mB8nJ4rY6sL0aD3fW-hGqE5uI7oPcNvZbXyMtRkS1jHlA2gU',
  user: user(777),
});

function main(): void {
  // ── положительный контроль ─────────────────────────────────────────────
  // Без него все отказы ниже ничего не значат: функция, отвергающая всё,
  // прошла бы такую проверку с отличием.
  const good = sign({ auth_date: now(), query_id: 'AAA', user: user(777) });
  const passed = verifyInitData(good);
  ok('верная подпись принимается', passed.ok && passed.user.id === 777, passed);

  // Полный набор полей живого клиента — то, что придёт на самом деле.
  const real = sign(realistic());
  const realRes = verifyInitData(real);
  ok('строка живого клиента принимается', realRes.ok && realRes.user.id === 777, realRes);

  /*
    Ключевая проверка. `signature` — подпись Ed25519 для тех, кто не знает
    токена бота; в проверке по токену она НЕ исключается из data-check-string,
    а участвует наравне со всеми полями. Если её выбросить, хеш перестанет
    сходиться со всем, что шлют современные клиенты, — а тест на урезанном
    наборе полей этого не заметит.

    Поэтому: правка `signature` обязана ломать подпись.
  */
  const tweaked = real.replace(/signature=[^&]+/, 'signature=AAAA');
  ok('signature участвует в подсчёте hash', verifyInitData(tweaked).ok === false, verifyInitData(tweaked));

  const noSignature = sign({ auth_date: now(), user: user(777) });
  ok('строка без signature тоже принимается', verifyInitData(noSignature).ok === true);

  // ── подпись ────────────────────────────────────────────────────────────
  ok('пустая строка отвергается', verifyInitData('').ok === false);
  ok('без hash отвергается', verifyInitData(`auth_date=${now()}&user=${encodeURIComponent(user(1))}`).ok === false);

  const foreign = sign({ auth_date: now(), user: user(777) }, '123456:НЕ-НАШ-ТОКЕН');
  ok('подпись чужим токеном отвергается', verifyInitData(foreign).ok === false, verifyInitData(foreign));

  // Главная атака: взять свою настоящую строку и поменять в ней id.
  const swapped = good.replace(encodeURIComponent(user(777)), encodeURIComponent(user(778)));
  ok('подмена user.id ломает подпись', verifyInitData(swapped).ok === false, verifyInitData(swapped));

  // Дописать поле к подписанной строке тоже нельзя.
  ok('дописанное поле ломает подпись', verifyInitData(good + '&is_admin=1').ok === false);

  // Обрезанный hash не должен проходить: сравнение обязано смотреть длину.
  const short = good.replace(/hash=([0-9a-f]+)/, (_, h: string) => `hash=${h.slice(0, 32)}`);
  ok('обрезанный hash отвергается', verifyInitData(short).ok === false);

  // Регистр hex: Telegram шлёт нижний, но сравнение не должно зависеть от удачи.
  const upper = good.replace(/hash=([0-9a-f]+)/, (_, h: string) => `hash=${h.toUpperCase()}`);
  const upperRes = verifyInitData(upper);
  ok('hash в верхнем регистре тоже принимается', upperRes.ok === true, upperRes);

  // ── срок жизни ─────────────────────────────────────────────────────────
  const old = String(Math.floor(Date.now() / 1000) - config.webapp.initDataTtlSec - 60);
  const stale = sign({ auth_date: old, user: user(777) });
  const staleRes = verifyInitData(stale);
  ok('просроченная подпись отвергается', !staleRes.ok && staleRes.reason === 'expired', staleRes);

  // ── обязательные поля ──────────────────────────────────────────────────
  const noUser = sign({ auth_date: now(), query_id: 'AAA' });
  const noUserRes = verifyInitData(noUser);
  ok('без user не пускаем', !noUserRes.ok && noUserRes.reason === 'no_user', noUserRes);

  const badDate = sign({ auth_date: 'вчера', user: user(777) });
  ok('нечисловой auth_date отвергается', verifyInitData(badDate).ok === false);

  // ── start_param доезжает ───────────────────────────────────────────────
  const withStart = sign({ auth_date: now(), user: user(777), start_param: 'MONKEY' });
  const startRes = verifyInitData(withStart);
  ok('start_param разбирается', startRes.ok && startRes.startParam === 'MONKEY', startRes);

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки прошли');
  process.exit(failed ? 1 : 0);
}

main();
