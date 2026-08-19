/** Алфавит без похожих символов: нет O/0, I/1, S/5. */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const LENGTH = 6;

export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Приводит ввод игрока к каноническому виду: «abc-123» -> «ABC123». */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRoomCode(input: string): boolean {
  const c = normalizeRoomCode(input);
  return c.length === LENGTH && [...c].every((ch) => ALPHABET.includes(ch));
}
