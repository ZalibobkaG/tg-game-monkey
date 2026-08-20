import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { feedback, users } from '../db/schema.js';

export type Feedback = typeof feedback.$inferSelect;
export type FeedbackKind = Feedback['kind'];
export type FeedbackStatus = Feedback['status'];

/** Обращение вместе с автором — карточка админа без лишнего похода в users. */
export type FeedbackWithUser = Feedback & { user: typeof users.$inferSelect };

const ZERO_COUNTS: Record<FeedbackStatus, number> = {
  new: 0,
  read: 0,
  answered: 0,
  archived: 0,
  spam: 0,
};

export async function createFeedback(args: {
  userId: number;
  roomId?: number | null;
  kind: FeedbackKind;
  text: string;
}): Promise<Feedback> {
  const [row] = await db
    .insert(feedback)
    .values({ userId: args.userId, roomId: args.roomId ?? null, kind: args.kind, text: args.text })
    .returning();
  return row!;
}

export async function getFeedback(id: number): Promise<FeedbackWithUser | undefined> {
  const [row] = await db
    .select()
    .from(feedback)
    .innerJoin(users, eq(feedback.userId, users.id))
    .where(eq(feedback.id, id))
    .limit(1);
  return row ? { ...row.feedback, user: row.users } : undefined;
}

export async function listFeedback(args: {
  status?: FeedbackStatus;
  limit?: number;
  offset?: number;
}): Promise<FeedbackWithUser[]> {
  const { status, limit = 10, offset = 0 } = args;
  const rows = await db
    .select()
    .from(feedback)
    .innerJoin(users, eq(feedback.userId, users.id))
    .where(status ? eq(feedback.status, status) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r.feedback, user: r.users }));
}

/** Один GROUP BY на все статусы разом — для шапки инбокса. */
export async function countByStatus(): Promise<Record<FeedbackStatus, number>> {
  const rows = await db
    .select({ status: feedback.status, count: sql<number>`count(*)::int` })
    .from(feedback)
    .groupBy(feedback.status);

  const result = { ...ZERO_COUNTS };
  for (const r of rows) result[r.status] = r.count;
  return result;
}

export async function setStatus(id: number, status: FeedbackStatus): Promise<void> {
  await db.update(feedback).set({ status }).where(eq(feedback.id, id));
}

export async function saveReply(id: number, adminUserId: number, reply: string): Promise<void> {
  await db
    .update(feedback)
    .set({ reply, answeredBy: adminUserId, answeredAt: new Date(), status: 'answered' })
    .where(eq(feedback.id, id));
}

/** Для антифлуда: не больше 3 обращений в час на пользователя. */
export async function countRecentByUser(userId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(feedback)
    .where(and(eq(feedback.userId, userId), gte(feedback.createdAt, since)));
  return row?.count ?? 0;
}
