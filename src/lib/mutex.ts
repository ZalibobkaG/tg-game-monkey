/**
 * Последовательная очередь операций на комнату.
 *
 * Переходы FSM партии нельзя выполнять параллельно: без этого два голоса,
 * пришедшие в один момент, оба видят «проголосовали все» и подсчёт идёт дважды.
 * Каждая комната получает свою цепочку промисов — операции внутри неё
 * выполняются строго по одной, разные комнаты друг друга не ждут.
 *
 * Блокировка НЕ реентерабельна: под замком можно вызывать только функции,
 * которые сами его не берут (в игре это `*Locked`-варианты).
 */
const chains = new Map<number, Promise<unknown>>();

export function withRoomLock<T>(roomId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(roomId) ?? Promise.resolve();
  // then(fn, fn) — следующая операция стартует независимо от того, упала ли предыдущая
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(roomId, tail);
  void tail.then(() => {
    if (chains.get(roomId) === tail) chains.delete(roomId);
  });
  return run;
}

export const pendingLocks = (): number => chains.size;
