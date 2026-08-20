import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { admins, users } from '../db/schema.js';
import { config } from '../config.js';
import type { User } from './users.js';

export type AdminRole = (typeof admins.$inferSelect)['role'];

/** Иерархия прав: owner может всё, support — только читать обращения и отвечать. */
const RANK: Record<AdminRole, number> = { support: 1, moderator: 2, owner: 3 };

export const atLeast = (role: AdminRole, needed: AdminRole): boolean => RANK[role] >= RANK[needed];

/**
 * Роль пользователя. ADMIN_IDS из окружения — бутстрап-владельцы: их нельзя
 * потерять, даже если таблицу почистят. Остальные назначаются из панели.
 */
export async function roleOf(user: Pick<User, 'id' | 'tgId'>): Promise<AdminRole | null> {
  if (config.adminIds.includes(user.tgId)) return 'owner';
  const row = await db.query.admins.findFirst({ where: eq(admins.userId, user.id) });
  return row?.role ?? null;
}

export type AdminRow = typeof admins.$inferSelect & { user: User };

export async function listAdmins(): Promise<AdminRow[]> {
  const rows = await db
    .select({ a: admins, u: users })
    .from(admins)
    .innerJoin(users, eq(users.id, admins.userId))
    .orderBy(asc(admins.createdAt));
  return rows.map((r) => ({ ...r.a, user: r.u }));
}

export async function setAdmin(userId: number, role: AdminRole, addedBy: number): Promise<void> {
  await db
    .insert(admins)
    .values({ userId, role, addedBy })
    .onConflictDoUpdate({ target: admins.userId, set: { role } });
}

export async function removeAdmin(userId: number): Promise<void> {
  await db.delete(admins).where(eq(admins.userId, userId));
}

export interface NotifyPlan {
  /** служебный чат, если задан: несколько админов видят одно и то же и не дублируют ответы */
  chat: number | null;
  /** личка каждого админа — запасной канал */
  dms: number[];
}

/**
 * Куда слать уведомления. Служебный чат — основной канал, но он же и
 * единственная точка отказа: неверный ADMIN_CHAT_ID или бот, не добавленный
 * в группу, означал бы, что обращения тихо теряются. Поэтому всегда
 * возвращаем и запасной список личек.
 */
export async function notifyPlan(): Promise<NotifyPlan> {
  const rows = await listAdmins();
  const dms = [...new Set([...config.adminIds, ...rows.map((r) => r.user.tgId)])];
  return { chat: config.adminChatId, dms };
}
