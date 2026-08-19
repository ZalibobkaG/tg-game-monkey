import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deckItems, decks, userDecks } from '../db/schema.js';

export type Deck = typeof decks.$inferSelect;

export async function listDecks(): Promise<Deck[]> {
  return db.select().from(decks).orderBy(asc(decks.sort), asc(decks.id));
}

export async function getDeck(id: number): Promise<Deck | undefined> {
  return db.query.decks.findFirst({ where: eq(decks.id, id) });
}

export async function getDeckBySlug(slug: string): Promise<Deck | undefined> {
  return db.query.decks.findFirst({ where: eq(decks.slug, slug) });
}

export async function deckActions(deckId: number): Promise<string[]> {
  const rows = await db.select({ text: deckItems.text }).from(deckItems).where(eq(deckItems.deckId, deckId));
  return rows.map((r) => r.text);
}

export async function ownsDeck(userId: number, deck: Deck): Promise<boolean> {
  if (!deck.isPremium) return true;
  const row = await db.query.userDecks.findFirst({
    where: and(eq(userDecks.userId, userId), eq(userDecks.deckId, deck.id)),
  });
  return Boolean(row);
}

/** Список колод с флагом доступа — для выбора в лобби и магазина. */
export async function decksFor(userId: number): Promise<Array<Deck & { owned: boolean }>> {
  const all = await listDecks();
  const owned = await db.select({ deckId: userDecks.deckId }).from(userDecks).where(eq(userDecks.userId, userId));
  const set = new Set(owned.map((o) => o.deckId));
  return all.map((d) => ({ ...d, owned: !d.isPremium || set.has(d.id) }));
}

export async function grantDeck(userId: number, deckId: number, paymentId?: number): Promise<void> {
  await db.insert(userDecks).values({ userId, deckId, paymentId: paymentId ?? null }).onConflictDoNothing();
}
