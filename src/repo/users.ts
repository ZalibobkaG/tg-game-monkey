import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { events, feedback, users } from '../db/schema.js';
import { Lru } from '../lib/lru.js';

export type User = typeof users.$inferSelect;

/**
 * Кеш пользователей. `upsertUser` зовётся на КАЖДЫЙ апдейт — без кеша это
 * самый горячий запрос в системе, притом почти всегда бесполезный:
 * имя и юзернейм не менялись. Пишем в БД, только если что-то изменилось
 * или пора обновить last_seen_at.
 */
const cache = new Lru<number, User>(10_000);
const SEEN_TTL_MS = 10 * 60 * 1000;

export async function upsertUser(tg: { id: number; username?: string; first_name?: string }): Promise<User> {
  const username = tg.username ?? null;
  const firstName = tg.first_name ?? '';

  const cached = cache.get(tg.id);
  if (
    cached &&
    cached.username === username &&
    cached.firstName === firstName &&
    Date.now() - cached.lastSeenAt.getTime() < SEEN_TTL_MS
  ) {
    return cached;
  }

  const now = new Date();
  const [row] = await db
    .insert(users)
    .values({ tgId: tg.id, username, firstName, lastSeenAt: now })
    .onConflictDoUpdate({
      target: users.tgId,
      set: { username, firstName, lastSeenAt: now },
    })
    .returning();
  cache.set(tg.id, row!);
  return row!;
}

export const cachedUsers = (): number => cache.size;

/** Сброс кеша — после бана или правки профиля из панели. */
export function invalidateUser(tgId: number): void {
  cache.delete(tgId);
}

/**
 * Обезличивание по запросу пользователя (/forget_me). Игровые агрегаты
 * остаются, но перестают быть персональными данными.
 */
export async function forgetUser(user: Pick<User, 'id' | 'tgId'>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ username: null, firstName: 'Удалённый', source: 'deleted', marketingOptOut: true })
      .where(eq(users.id, user.id));
    await tx
      .update(feedback)
      .set({ text: '[удалено по запросу автора]', reply: null })
      .where(eq(feedback.userId, user.id));
    await tx.update(events).set({ userId: null }).where(eq(events.userId, user.id));
  });
  invalidateUser(user.tgId);
}

export async function setBanned(user: Pick<User, 'id' | 'tgId'>, until: Date | null): Promise<void> {
  await db.update(users).set({ bannedUntil: until }).where(eq(users.id, user.id));
  invalidateUser(user.tgId);
}

export async function getUserById(id: number): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

export function displayName(u: Pick<User, 'firstName' | 'username'>): string {
  const name = u.firstName?.trim();
  if (name) return name;
  if (u.username) return `@${u.username}`;
  return 'Игрок';
}
