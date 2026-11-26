import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Проверка `initData` мини-аппа.
 *
 * Мини-апп — обычная веб-страница в браузере Telegram, и всё, что она
 * присылает нам, приходит из клиента, то есть от кого угодно. Единственное,
 * чему здесь можно верить, — строка `initData`: Telegram подписывает её
 * ключом, выведенным из токена бота. Без этой проверки мини-апп открывает
 * дыру шириной с API: любой смог бы прислать `user.id` соседа.
 *
 * Алгоритм из документации (Mini Apps → Validating data):
 *   secret_key        = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   data_check_string = отсортированные `key=value`, склеенные "\n", без `hash`
 *   hash              = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
 *
 * Из строки выбрасывается ТОЛЬКО `hash`. Поле `signature` — подпись Ed25519
 * для тех, кто токена бота не знает и проверяет данные публичным ключом
 * Telegram, — в подсчёт входит наравне со всеми: «все полученные поля»
 * означает именно все. Оба поля исключаются лишь в той, второй проверке.
 * Выбросить `signature` здесь — значит отвергать всё, что присылают
 * современные клиенты: они его шлют всегда.
 */

export interface TmaUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export type AuthResult =
  | { ok: true; user: TmaUser; authDate: Date; startParam: string | null; queryId: string | null }
  | { ok: false; reason: 'empty' | 'malformed' | 'bad_hash' | 'expired' | 'no_user' };

/** Секрет считается один раз: HMAC на каждый запрос — лишняя работа впустую. */
let secretKey: Buffer | null = null;
function secret(): Buffer {
  if (!secretKey) secretKey = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  return secretKey;
}

/** Сравнение подписи. Посимвольное «==» здесь утекает по времени — берём timingSafeEqual. */
function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verifyInitData(initData: string): AuthResult {
  if (!initData) return { ok: false, reason: 'empty' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'malformed' };

  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const expected = createHmac('sha256', secret()).update(pairs.join('\n')).digest('hex');
  if (!hashEquals(expected, hash)) return { ok: false, reason: 'bad_hash' };

  // Подпись вечная: Telegram выдаёт initData один раз при открытии и больше
  // не переподписывает. Поэтому окно тут не «пять минут», как в OAuth,
  // а срок жизни сессии мини-аппа — иначе приложение отвалилось бы у всех,
  // кто оставил его открытым.
  const authDateSec = Number(params.get('auth_date') ?? 0);
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) return { ok: false, reason: 'malformed' };
  const ageSec = Date.now() / 1000 - authDateSec;
  if (ageSec > config.webapp.initDataTtlSec) return { ok: false, reason: 'expired' };

  const rawUser = params.get('user');
  if (!rawUser) return { ok: false, reason: 'no_user' };

  let user: TmaUser;
  try {
    user = JSON.parse(rawUser) as TmaUser;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!user || typeof user.id !== 'number') return { ok: false, reason: 'no_user' };

  return {
    ok: true,
    user,
    authDate: new Date(authDateSec * 1000),
    startParam: params.get('start_param'),
    queryId: params.get('query_id'),
  };
}
