/**
 * Ожидание текстового ввода от пользователя: код комнаты, свой код,
 * текст обращения, ответ админа.
 *
 * `peek` не потребляет ожидание — это важно, потому что обработчики текста
 * живут в разных композерах: каждый смотрит, его ли это ввод, и либо забирает
 * его через `clear`, либо пропускает сообщение дальше.
 */
export type PendingKind = 'room_code' | 'custom_code' | 'feedback' | 'feedback_reply' | 'admin_search';

export interface Pending {
  kind: PendingKind;
  /** произвольная привязка — например id обращения, на которое отвечает админ */
  payload?: string;
  until: number;
}

const TTL_MS = 30 * 60 * 1000;
const pending = new Map<number, Pending>();

export function expect(tgId: number, kind: PendingKind, payload?: string): void {
  pending.set(tgId, { kind, payload, until: Date.now() + TTL_MS });
}

/** Смотрит, не потребляя. Протухшее считается отсутствующим и вычищается. */
export function peek(tgId: number): Pending | null {
  const p = pending.get(tgId);
  if (!p) return null;
  if (p.until <= Date.now()) {
    pending.delete(tgId);
    return null;
  }
  return p;
}

export function take(tgId: number): Pending | null {
  const p = peek(tgId);
  if (p) pending.delete(tgId);
  return p;
}

export function clear(tgId: number): void {
  pending.delete(tgId);
}
