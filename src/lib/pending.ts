/** Ожидание текстового ввода от игрока (например, кода комнаты). */
const TTL_MS = 5 * 60 * 1000;
const pending = new Map<number, { kind: 'room_code'; until: number }>();

export function expect(tgId: number, kind: 'room_code'): void {
  pending.set(tgId, { kind, until: Date.now() + TTL_MS });
}

export function take(tgId: number): 'room_code' | null {
  const p = pending.get(tgId);
  if (!p) return null;
  pending.delete(tgId);
  return p.until > Date.now() ? p.kind : null;
}

export function clear(tgId: number): void {
  pending.delete(tgId);
}
