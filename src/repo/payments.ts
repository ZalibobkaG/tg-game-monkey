import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { decks, payments, users } from '../db/schema.js';
import type { paymentKind, paymentProvider } from '../db/schema.js';

/**
 * Заказы. Единственное место, где решается, проведён платёж или нет.
 *
 * И `successful_payment` от Telegram, и вебхук кассы могут прийти дважды —
 * повтор вебхука это вообще штатное поведение при таймауте. Поэтому выдачу
 * товара вешаем не на факт прихода апдейта, а на успешный перевод заказа
 * из `pending`: перевести его может только один вызов, остальные увидят,
 * что строк не обновилось, и промолчат.
 */

export type Payment = typeof payments.$inferSelect;
export type PaymentProvider = (typeof paymentProvider.enumValues)[number];
export type PaymentKind = (typeof paymentKind.enumValues)[number];

export interface NewOrder {
  userId: number;
  kind: PaymentKind;
  deckId?: number | null;
  provider: PaymentProvider;
  orderId: string;
  amountMinor: number;
  currency: string;
  coinsAmount?: number;
  metadata?: Record<string, unknown>;
}

export async function createOrder(o: NewOrder): Promise<Payment> {
  const [row] = await db
    .insert(payments)
    .values({
      userId: o.userId,
      kind: o.kind,
      deckId: o.deckId ?? null,
      provider: o.provider,
      orderId: o.orderId,
      amountMinor: o.amountMinor,
      currency: o.currency,
      coinsAmount: o.coinsAmount ?? 0,
      metadata: o.metadata ?? {},
    })
    .returning();
  return row!;
}

export async function byOrderId(orderId: string): Promise<Payment | undefined> {
  return db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
}

export async function byId(id: number): Promise<Payment | undefined> {
  return db.query.payments.findFirst({ where: eq(payments.id, id) });
}

/** Ссылку на оплату сохраняем, чтобы вернувшийся к заказу человек не плодил новые. */
export async function setPayUrl(id: number, payUrl: string, externalId?: string): Promise<void> {
  await db
    .update(payments)
    .set({ payUrl, ...(externalId ? { externalId } : {}) })
    .where(eq(payments.id, id));
}

export type SettleResult =
  /** этот вызов перевёл заказ в «оплачен» — товар выдаём именно здесь */
  | { ok: true; payment: Payment }
  /** заказ уже был обработан (повторный вебхук) или его нет */
  | { ok: false; reason: 'already_settled' | 'not_found'; payment?: Payment };

/**
 * Провести оплату. Условие `status = 'pending'` внутри UPDATE — это и есть
 * защита от двойной выдачи: гонку двух вебхуков разрешает база, а не мы.
 */
export async function markPaid(args: {
  orderId: string;
  externalId?: string | null;
  telegramChargeId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SettleResult> {
  const existing = await byOrderId(args.orderId);
  if (!existing) return { ok: false, reason: 'not_found' };

  const rows = await db
    .update(payments)
    .set({
      status: 'paid',
      paidAt: new Date(),
      ...(args.externalId ? { externalId: args.externalId } : {}),
      ...(args.telegramChargeId ? { telegramChargeId: args.telegramChargeId } : {}),
      ...(args.metadata ? { metadata: { ...existing.metadata, ...args.metadata } } : {}),
    })
    .where(and(eq(payments.orderId, args.orderId), eq(payments.status, 'pending')))
    .returning();

  if (!rows.length) return { ok: false, reason: 'already_settled', payment: existing };
  return { ok: true, payment: rows[0]! };
}

export async function markFailed(
  orderId: string,
  status: 'canceled' | 'failed',
  metadata?: Record<string, unknown>,
): Promise<void> {
  const existing = await byOrderId(orderId);
  if (!existing) return;
  await db
    .update(payments)
    .set({ status, ...(metadata ? { metadata: { ...existing.metadata, ...metadata } } : {}) })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')));
}

/** Возврат. Как и оплата — только из соответствующего состояния и только раз. */
export async function markRefunded(id: number): Promise<Payment | null> {
  const rows = await db
    .update(payments)
    .set({ status: 'refunded', refundedAt: new Date() })
    .where(and(eq(payments.id, id), eq(payments.status, 'paid')))
    .returning();
  return rows[0] ?? null;
}

export async function listForUser(userId: number, limit = 20): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
}

export type PaymentRow = Payment & { userName: string; deckTitle: string | null };

export async function recent(limit = 20): Promise<PaymentRow[]> {
  const rows = await db
    .select({ p: payments, u: users, d: decks })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.userId))
    .leftJoin(decks, eq(decks.id, payments.deckId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r.p,
    userName: r.u.firstName?.trim() || (r.u.username ? `@${r.u.username}` : 'Игрок'),
    deckTitle: r.d?.title ?? null,
  }));
}

export interface Revenue {
  provider: PaymentProvider;
  currency: string;
  count: number;
  amountMinor: number;
}

/** Выручка за период, разбитая по кассам: складывать XTR с рублями нельзя. */
export async function revenueSince(from: Date): Promise<Revenue[]> {
  const rows = await db
    .select({
      provider: payments.provider,
      currency: payments.currency,
      count: sql<number>`count(*)`,
      amountMinor: sql<number>`coalesce(sum(${payments.amountMinor}), 0)`,
    })
    .from(payments)
    .where(and(eq(payments.status, 'paid'), gte(payments.paidAt, from)))
    .groupBy(payments.provider, payments.currency);

  return rows.map((r) => ({
    provider: r.provider,
    currency: r.currency,
    count: Number(r.count),
    amountMinor: Number(r.amountMinor),
  }));
}

/**
 * Заказ, по которому человек уже начал платить, но не закончил. Показываем
 * ту же ссылку вместо новой: два открытых счёта на одну колоду — верный
 * способ получить две оплаты и один товар.
 */
export async function pendingOrder(
  userId: number,
  provider: PaymentProvider,
  deckId: number | null,
  maxAgeMs: number,
): Promise<Payment | undefined> {
  const since = new Date(Date.now() - maxAgeMs);
  return db.query.payments.findFirst({
    where: and(
      eq(payments.userId, userId),
      eq(payments.provider, provider),
      eq(payments.status, 'pending'),
      deckId === null ? sql`${payments.deckId} is null` : eq(payments.deckId, deckId),
      gte(payments.createdAt, since),
    ),
  });
}
