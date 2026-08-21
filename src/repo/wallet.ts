import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { walletLedger, wallets } from '../db/schema.js';
import type { ledgerReason } from '../db/schema.js';

/**
 * Личный счёт в 🍌.
 *
 * Баланс в `wallets` — материализованный итог журнала. Любое движение
 * проводится одной транзакцией: сначала обновляем баланс условным UPDATE,
 * потом пишем строку журнала с уже посчитанным `balance_after`. Читать
 * баланс, решать в приложении и писать обратно нельзя — два одновременных
 * списания увели бы счёт в минус.
 */

export type LedgerReason = (typeof ledgerReason.enumValues)[number];
export type LedgerRow = typeof walletLedger.$inferSelect;

export interface Wallet {
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

const EMPTY: Wallet = { balance: 0, totalEarned: 0, totalSpent: 0 };

export async function getWallet(userId: number): Promise<Wallet> {
  const row = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
  return row ? { balance: row.balance, totalEarned: row.totalEarned, totalSpent: row.totalSpent } : EMPTY;
}

export async function balanceOf(userId: number): Promise<number> {
  return (await getWallet(userId)).balance;
}

export interface Movement {
  userId: number;
  amount: number;
  reason: LedgerReason;
  refId?: number | null;
  comment?: string;
}

/**
 * Начисление. Счёт заводится на лету: строки в `wallets` нет ровно до
 * первого движения, поэтому upsert, а не update.
 */
export async function credit(m: Movement): Promise<number> {
  if (m.amount <= 0) throw new Error('credit: сумма должна быть положительной');

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(wallets)
      .values({ userId: m.userId, balance: m.amount, totalEarned: m.amount, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: wallets.userId,
        set: {
          balance: sql`${wallets.balance} + ${m.amount}`,
          totalEarned: sql`${wallets.totalEarned} + ${m.amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ balance: wallets.balance });

    const balanceAfter = row!.balance;
    await tx.insert(walletLedger).values({
      userId: m.userId,
      delta: m.amount,
      balanceAfter,
      reason: m.reason,
      refId: m.refId ?? null,
      comment: m.comment ?? '',
    });
    return balanceAfter;
  });
}

export type DebitResult =
  | { ok: true; balance: number }
  | { ok: false; balance: number };

/**
 * Списание. Условие `balance >= amount` стоит в самом UPDATE: если строк
 * не обновилось — денег не хватило, и мы ничего не трогали. Проверка
 * заранее отдельным запросом здесь не годится: между ней и записью
 * успевает пройти второе списание.
 */
export async function debit(m: Movement): Promise<DebitResult> {
  if (m.amount <= 0) throw new Error('debit: сумма должна быть положительной');

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} - ${m.amount}`,
        totalSpent: sql`${wallets.totalSpent} + ${m.amount}`,
        updatedAt: new Date(),
      })
      .where(sql`${wallets.userId} = ${m.userId} and ${wallets.balance} >= ${m.amount}`)
      .returning({ balance: wallets.balance });

    if (!updated.length) {
      const [current] = await tx
        .select({ balance: wallets.balance })
        .from(wallets)
        .where(eq(wallets.userId, m.userId));
      return { ok: false, balance: current?.balance ?? 0 };
    }

    const balanceAfter = updated[0]!.balance;
    await tx.insert(walletLedger).values({
      userId: m.userId,
      delta: -m.amount,
      balanceAfter,
      reason: m.reason,
      refId: m.refId ?? null,
      comment: m.comment ?? '',
    });
    return { ok: true, balance: balanceAfter };
  });
}

/**
 * Правка баланса из панели: сумма со знаком. Отдельно от credit/debit,
 * потому что админу разрешено уводить счёт в ноль, но не в минус.
 */
export async function adjust(
  userId: number,
  delta: number,
  adminUserId: number,
  comment = '',
): Promise<DebitResult> {
  if (delta === 0) return { ok: true, balance: await balanceOf(userId) };
  if (delta > 0) {
    const balance = await credit({ userId, amount: delta, reason: 'admin_adjust', refId: adminUserId, comment });
    return { ok: true, balance };
  }
  return debit({ userId, amount: -delta, reason: 'admin_adjust', refId: adminUserId, comment });
}

export async function history(userId: number, limit = 20): Promise<LedgerRow[]> {
  return db
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.userId, userId))
    .orderBy(sql`${walletLedger.createdAt} desc`)
    .limit(limit);
}
