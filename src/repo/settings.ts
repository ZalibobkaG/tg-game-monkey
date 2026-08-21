import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { DEFAULT_ECONOMY, ECONOMY_KEY } from '../domain/economy.js';
import type { Economy } from '../domain/economy.js';
import { log } from '../lib/log.js';

/**
 * Настройки, редактируемые из панели. Читаются на каждый показ магазина,
 * поэтому держим в памяти и обновляем по TTL: секунда расхождения между
 * двумя процессами безобидна, а поход в базу на каждую кнопку — нет.
 */

const TTL_MS = 30_000;

let cached: Economy | null = null;
let cachedAt = 0;

/**
 * Слияние с умолчаниями, а не подстановка: в базе лежит снимок настроек,
 * снятый старой версией кода, и новые поля там просто отсутствуют.
 * Без этого добавление любой настройки роняло бы магазин на `undefined`.
 */
function merge(raw: unknown): Economy {
  if (!raw || typeof raw !== 'object') return DEFAULT_ECONOMY;
  const v = raw as Partial<Economy>;
  return {
    providers: { ...DEFAULT_ECONOMY.providers, ...(v.providers ?? {}) },
    referral: { ...DEFAULT_ECONOMY.referral, ...(v.referral ?? {}) },
    rates: { ...DEFAULT_ECONOMY.rates, ...(v.rates ?? {}) },
  };
}

export async function getEconomy(): Promise<Economy> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const row = await db.query.settings.findFirst({ where: eq(settings.key, ECONOMY_KEY) });
    cached = merge(row?.value);
  } catch (e) {
    // База недоступна — отдаём последнее известное значение, а не падаем:
    // магазин лучше показать по умолчаниям, чем не показать вовсе.
    log.error({ err: e }, 'настройки: не смог прочитать экономику');
    cached = cached ?? DEFAULT_ECONOMY;
  }
  cachedAt = Date.now();
  return cached;
}

export async function saveEconomy(next: Economy, updatedBy: number): Promise<Economy> {
  const [row] = await db
    .insert(settings)
    .values({ key: ECONOMY_KEY, value: next, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedBy, updatedAt: new Date() },
    })
    .returning();
  cached = merge(row?.value);
  cachedAt = Date.now();
  return cached;
}

/**
 * Точечная правка. Читает свежее значение из базы, а не из кеша: иначе два
 * админа, нажимающие кнопки одновременно, затирали бы правки друг друга.
 */
export async function patchEconomy(
  updatedBy: number,
  patch: (e: Economy) => Economy,
): Promise<Economy> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, ECONOMY_KEY) });
  return saveEconomy(patch(merge(row?.value)), updatedBy);
}

/** Сброс кеша — после правки из другого процесса. */
export function invalidateEconomy(): void {
  cached = null;
  cachedAt = 0;
}
