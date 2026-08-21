/**
 * Разбор списка действий, который админ присылает текстом.
 *
 * Одно действие — одна строка. Списки админы копируют откуда угодно, поэтому
 * нумерацию и маркеры в начале строки срезаем сами, а не заставляем чистить
 * руками. Всё остальное — жёстко: молча проглоченный мусор попадёт людям
 * в карточки посреди партии, и починить это будет уже некому.
 */
import { RULES } from './rules.js';

export const ITEM_MIN_LEN = 2;
export const ITEM_MAX_LEN = 80;
/** Потолок на одно сообщение: в Telegram всё равно не влезет больше ~4000 символов. */
export const MAX_ITEMS = 100;

/** «1.», «2)», «-», «•», «*» в начале строки — это оформление, а не действие. */
const BULLET_RE = /^\s*(?:\d{1,3}\s*[.)\]]|[-–—•*])\s*/u;

export type DeckEditMode = 'add' | 'set';

export type ParseResult =
  | { ok: true; items: string[]; total: number }
  | { ok: false; errors: string[] };

/** Ключ сравнения на повтор: регистр, лишние пробелы и хвостовая точка не считаются. */
function key(s: string): string {
  return s.toLowerCase().replace(/\s+/gu, ' ').replace(/[.!…]+$/u, '').trim();
}

function clean(line: string): string {
  return line.replace(BULLET_RE, '').replace(/\s+/gu, ' ').trim();
}

/** Не больше трёх примеров в списке ошибок — иначе сообщение читать невозможно. */
function sample(items: string[]): string {
  const head = items.slice(0, 3).join('», «');
  return items.length > 3 ? `«${head}» и ещё ${items.length - 3}` : `«${head}»`;
}

export function parseActions(args: {
  raw: string;
  mode: DeckEditMode;
  /** что уже лежит в колоде — для проверки на повтор и на итоговый размер */
  existing: string[];
}): ParseResult {
  const { raw, mode, existing } = args;

  const items: string[] = [];
  const errors: string[] = [];
  const tooShort: string[] = [];
  const tooLong: string[] = [];
  const dupInside: string[] = [];
  const dupExisting: string[] = [];

  const seen = new Map<string, number>();
  const inDeck = new Set(existing.map(key));

  for (const line of raw.split('\n')) {
    const text = clean(line);
    if (!text) continue;

    if (text.length < ITEM_MIN_LEN) {
      tooShort.push(text);
      continue;
    }
    if (text.length > ITEM_MAX_LEN) {
      tooLong.push(`${text.slice(0, 30)}…`);
      continue;
    }

    const k = key(text);
    if (seen.has(k)) {
      dupInside.push(text);
      continue;
    }
    if (mode === 'add' && inDeck.has(k)) {
      dupExisting.push(text);
      continue;
    }
    seen.set(k, items.length);
    items.push(text);
  }

  if (!items.length && !tooShort.length && !tooLong.length && !dupInside.length && !dupExisting.length) {
    return { ok: false, errors: ['Не вижу ни одного действия — сообщение пустое.'] };
  }

  if (tooShort.length) errors.push(`Слишком коротко (нужно от ${ITEM_MIN_LEN} символов): ${sample(tooShort)}`);
  if (tooLong.length) errors.push(`Слишком длинно (максимум ${ITEM_MAX_LEN} символов): ${sample(tooLong)}`);
  if (dupInside.length) errors.push(`Повторы внутри списка: ${sample(dupInside)}`);
  if (dupExisting.length) errors.push(`Уже есть в колоде: ${sample(dupExisting)}`);
  if (items.length > MAX_ITEMS) errors.push(`За раз не больше ${MAX_ITEMS} действий, а прислано ${items.length}.`);

  const total = mode === 'add' ? existing.length + items.length : items.length;
  if (total < RULES.cardSize) {
    errors.push(
      `В колоде должно остаться минимум ${RULES.cardSize} действий — по карточке раздаём ровно столько. ` +
        `Получается ${total}.`,
    );
  }

  return errors.length ? { ok: false, errors } : { ok: true, items, total };
}
