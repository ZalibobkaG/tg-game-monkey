import { randomInt } from 'node:crypto';

/** Алфавит для генерации: без похожих символов (нет O/0, I/1, S/5). */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const GENERATE_LENGTH = 6;

export const MIN_CODE_LEN = 4;
export const MAX_CODE_LEN = 12;

/** Служебные слова — их нельзя занимать под код комнаты. */
const RESERVED_WORDS = new Set<string>([
  'START', 'STOP', 'HELP', 'RULES', 'ROOM', 'ROOMS', 'LEAVE', 'GAME', 'GAMES',
  'ADMIN', 'ADMINS', 'BOT', 'TEST', 'NULL', 'NONE', 'UNDEFINED', 'CANCEL',
  'STATS', 'FEEDBACK', 'PRIVACY', 'MONKEY', 'OBEZYANKA',
]);

/** Обсценная лексика (транслит + английский). Отдельная константа, чтобы легко дополнять. */
const PROFANITY_WORDS = new Set<string>([
  'BLYAT', 'BLYA', 'SUKA', 'PIDOR', 'PIDR', 'HUY', 'HUI', 'PIZDA', 'PIZDEC',
  'EBAT', 'EBAL', 'MUDAK', 'MUDILA', 'GONDON', 'CHMO', 'ZALUPA',
  'FUCK', 'SHIT',
]);

/** Кириллица — проверяется до нормализации, иначе схлопнется в пустую строку. */
const CYRILLIC_RE = /[А-Яа-яЁё]/;

/** Символы, которые допустимо использовать как разделитель и молча вырезать. */
const SEPARATOR_RE = /[-_\s]/g;

export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < GENERATE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)]!;
  }
  return out;
}

/** Приводит ввод игрока к каноническому виду: «abc-123» -> «ABC123». */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type CodeError = 'empty' | 'too_short' | 'too_long' | 'cyrillic' | 'bad_chars' | 'reserved';

/**
 * Валидирует код, который админ комнаты вводит вручную (широкий алфавит A-Z0-9,
 * в отличие от узкого алфавита generateRoomCode).
 */
export function validateCustomCode(
  input: string,
): { ok: true; code: string } | { ok: false; reason: CodeError } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  if (CYRILLIC_RE.test(trimmed)) {
    return { ok: false, reason: 'cyrillic' };
  }

  // То, что осталось после вырезания только разрешённых разделителей.
  const withoutSeparators = trimmed.replace(SEPARATOR_RE, '');
  if (withoutSeparators.length === 0) {
    // Ввод состоял из одних разделителей — по сути ничего не введено.
    return { ok: false, reason: 'empty' };
  }

  const code = normalizeRoomCode(trimmed);
  if (code.length !== withoutSeparators.length) {
    // normalizeRoomCode вырезал что-то ещё, помимо разделителей — недопустимые символы.
    return { ok: false, reason: 'bad_chars' };
  }

  if (code.length < MIN_CODE_LEN) {
    return { ok: false, reason: 'too_short' };
  }
  if (code.length > MAX_CODE_LEN) {
    return { ok: false, reason: 'too_long' };
  }

  if (RESERVED_WORDS.has(code) || PROFANITY_WORDS.has(code)) {
    return { ok: false, reason: 'reserved' };
  }

  return { ok: true, code };
}

/** Готовый текст ошибки для пользователя. */
export function codeErrorText(reason: CodeError): string {
  switch (reason) {
    case 'empty':
      return 'Пустой код. Пришли его текстом — например <code>LITVIN</code>.';
    case 'too_short':
      return `Слишком короткий код — нужно минимум ${MIN_CODE_LEN} символа.`;
    case 'too_long':
      return `Слишком длинный код — максимум ${MAX_CODE_LEN} символов.`;
    case 'cyrillic':
      return 'Похоже, включена русская раскладка. Код нужен латиницей.';
    case 'bad_chars':
      return 'Только латинские буквы и цифры. Дефис, подчёркивание и пробел можно — их вырежу.';
    case 'reserved':
      return 'Этот код занять нельзя. Придумай другой.';
  }
}

/** Дешёвый предфильтр: похоже ли сообщение на попытку ввести код комнаты. */
export function looksLikeJoinInput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('/')) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    // Не одно слово — внутри trim остались пробелы или переносы.
    return false;
  }

  const code = normalizeRoomCode(trimmed);
  return code.length >= MIN_CODE_LEN && code.length <= MAX_CODE_LEN;
}
