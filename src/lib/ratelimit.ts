/**
 * Скользящее окно на ключ. Нужен там, где перебор дёшев:
 * с коротким кодом вроде MONKEY подобрать чужую комнату — вопрос минут.
 */
export interface RateLimiter {
  /** true — можно; false — лимит исчерпан. */
  take(key: number): boolean;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<number, number[]>();

  // редкая уборка, чтобы карта не росла от разовых посетителей
  const sweep = setInterval(() => {
    const edge = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const left = times.filter((t) => t > edge);
      if (left.length) hits.set(key, left);
      else hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return {
    take(key) {
      const now = Date.now();
      const times = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return false;
      }
      times.push(now);
      hits.set(key, times);
      return true;
    },
  };
}
