import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export type User = typeof users.$inferSelect;

export async function upsertUser(tg: { id: number; username?: string; first_name?: string }): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ tgId: tg.id, username: tg.username ?? null, firstName: tg.first_name ?? '' })
    .onConflictDoUpdate({
      target: users.tgId,
      set: { username: tg.username ?? null, firstName: tg.first_name ?? '' },
    })
    .returning();
  return row!;
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
