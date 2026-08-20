import { log } from './log.js';
/**
 * Схлопывание частых задач по ключу (обычно ключ — id комнаты).
 *
 * Когда компания из десяти человек сканирует QR одновременно, лобби
 * перерисовывается сто раз, а полезны только последние десять правок.
 * `waitMs` — пауза тишины перед запуском, `maxWaitMs` — потолок ожидания,
 * чтобы поток непрерывных событий не откладывал отрисовку бесконечно.
 */
export interface Debouncer {
  schedule(key: number, run: () => Promise<void> | void): void;
  cancel(key: number): void;
  size(): number;
}

interface Slot {
  timer: NodeJS.Timeout;
  run: () => Promise<void> | void;
  deadline: number;
}

export function createDebouncer(waitMs: number, maxWaitMs = waitMs * 4): Debouncer {
  const slots = new Map<number, Slot>();

  function fire(key: number): void {
    const slot = slots.get(key);
    if (!slot) return;
    slots.delete(key);
    void (async () => {
      try {
        await slot.run();
      } catch (e) {
        log.error({ err: e }, 'отложенная задача упала');
      }
    })();
  }

  return {
    schedule(key, run) {
      const now = Date.now();
      const prev = slots.get(key);
      if (prev) clearTimeout(prev.timer);
      const deadline = prev?.deadline ?? now + maxWaitMs;
      const delay = Math.max(0, Math.min(waitMs, deadline - now));
      const timer = setTimeout(() => fire(key), delay);
      timer.unref();
      slots.set(key, { timer, run, deadline });
    },
    cancel(key) {
      const slot = slots.get(key);
      if (!slot) return;
      clearTimeout(slot.timer);
      slots.delete(key);
    },
    size: () => slots.size,
  };
}
