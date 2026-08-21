import { count, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { referralCodes, referrals, users } from '../db/schema.js';
import { generateReferralCode } from '../lib/code.js';
import { log } from '../lib/log.js';

/**
 * Реферальная программа: связи «кто кого привёл» и личные коды.
 *
 * Начисления сюда намеренно не входят — их правила ещё не утверждены и будут
 * меняться. А вот сама связь восстановлению задним числом не поддаётся,
 * поэтому пишем её с самого начала, независимо от того, включены бонусы или нет.
 */

export type Referral = typeof referrals.$inferSelect;

/** Личный код. Заводится лениво — при первом открытии экрана приглашений. */
export async function ensureCode(userId: number): Promise<string> {
  const existing = await db.query.referralCodes.findFirst({
    where: eq(referralCodes.userId, userId),
  });
  if (existing) return existing.code;

  // Коллизия на 30^8 маловероятна, но не невозможна: ловим её уникальным
  // индексом и пробуем ещё раз, а не проверкой существования заранее.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const [row] = await db
      .insert(referralCodes)
      .values({ userId, code })
      .onConflictDoNothing()
      .returning();
    if (row) return row.code;

    // onConflictDoNothing молчит про то, какой именно индекс сработал:
    // либо код занят другим, либо этот пользователь успел завестись параллельно.
    const mine = await db.query.referralCodes.findFirst({ where: eq(referralCodes.userId, userId) });
    if (mine) return mine.code;
  }
  throw new Error(`не смог выдать реферальный код пользователю ${userId}`);
}

export async function userIdByCode(code: string): Promise<number | null> {
  const row = await db.query.referralCodes.findFirst({ where: eq(referralCodes.code, code) });
  return row?.userId ?? null;
}

export type AttachResult =
  | { ok: true; referrerId: number }
  | { ok: false; reason: 'unknown_code' | 'self' | 'already_attached' | 'not_new' };

/**
 * Привязать приглашённого к пригласившему.
 *
 * Условия намеренно строгие: пригласить можно только того, кто ещё не
 * привязан и кто сам ещё не играл. Иначе программу тривиально накрутить —
 * достаточно разослать ссылку тем, кто уже пользуется ботом.
 */
export async function attach(
  inviteeId: number,
  code: string,
  opts: { maxAgeMs: number },
): Promise<AttachResult> {
  const referrerId = await userIdByCode(code);
  if (!referrerId) return { ok: false, reason: 'unknown_code' };
  if (referrerId === inviteeId) return { ok: false, reason: 'self' };

  const invitee = await db.query.users.findFirst({ where: eq(users.id, inviteeId) });
  if (!invitee) return { ok: false, reason: 'unknown_code' };
  if (Date.now() - invitee.createdAt.getTime() > opts.maxAgeMs) {
    return { ok: false, reason: 'not_new' };
  }

  // Первичный ключ по invitee_id: кто успел, тот и пригласил.
  const [row] = await db
    .insert(referrals)
    .values({ inviteeId, referrerId, source: 'deeplink' })
    .onConflictDoNothing()
    .returning();

  if (!row) return { ok: false, reason: 'already_attached' };
  log.info({ inviteeId, referrerId }, 'реферал привязан');
  return { ok: true, referrerId };
}

export async function referrerOf(inviteeId: number): Promise<Referral | undefined> {
  return db.query.referrals.findFirst({ where: eq(referrals.inviteeId, inviteeId) });
}

export interface ReferralStats {
  invited: number;
  earned: number;
}

export async function statsOf(referrerId: number): Promise<ReferralStats> {
  const [row] = await db
    .select({ invited: count(), earned: sql<number>`coalesce(sum(${referrals.earned}), 0)` })
    .from(referrals)
    .where(eq(referrals.referrerId, referrerId));
  return { invited: Number(row?.invited ?? 0), earned: Number(row?.earned ?? 0) };
}

/** Отметить, что приветственный бонус приглашённому уже выдан. */
export async function markSignupRewarded(inviteeId: number): Promise<boolean> {
  const rows = await db
    .update(referrals)
    .set({ signupRewarded: true })
    .where(sql`${referrals.inviteeId} = ${inviteeId} and ${referrals.signupRewarded} = false`)
    .returning({ inviteeId: referrals.inviteeId });
  return rows.length > 0;
}

/** Накопленный доход с конкретного реферала — по нему работает потолок начислений. */
export async function addEarned(inviteeId: number, amount: number): Promise<void> {
  await db
    .update(referrals)
    .set({ earned: sql`${referrals.earned} + ${amount}` })
    .where(eq(referrals.inviteeId, inviteeId));
}

export type TopReferrer = { userId: number; name: string; invited: number; earned: number };

/** Лидеры программы — для панели: видно, кто реально приводит людей. */
export async function topReferrers(limit = 10): Promise<TopReferrer[]> {
  const rows = await db
    .select({
      userId: referrals.referrerId,
      firstName: users.firstName,
      username: users.username,
      invited: count(),
      earned: sql<number>`coalesce(sum(${referrals.earned}), 0)`,
    })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.referrerId))
    .groupBy(referrals.referrerId, users.firstName, users.username)
    .orderBy(sql`count(*) desc`)
    .limit(limit);

  return rows.map((r) => ({
    userId: r.userId,
    name: r.firstName?.trim() || (r.username ? `@${r.username}` : 'Игрок'),
    invited: Number(r.invited),
    earned: Number(r.earned),
  }));
}
