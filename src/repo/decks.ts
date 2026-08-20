import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deckItems, decks, games, userDecks } from '../db/schema.js';

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

export type DeckSummary = Deck & { items: number; games: number };

/** Сводка для админ-панели: сколько в колоде действий и сколько ей сыграли. */
export async function deckSummary(): Promise<DeckSummary[]> {
  const all = await listDecks();
  const items = await db
    .select({ deckId: deckItems.deckId, n: count() })
    .from(deckItems)
    .groupBy(deckItems.deckId);
  const played = await db.select({ deckId: games.deckId, n: count() }).from(games).groupBy(games.deckId);

  const itemsBy = new Map(items.map((r) => [r.deckId, Number(r.n)]));
  const playedBy = new Map(played.map((r) => [r.deckId, Number(r.n)]));
  return all.map((d) => ({ ...d, items: itemsBy.get(d.id) ?? 0, games: playedBy.get(d.id) ?? 0 }));
}

export async function revokeDeck(userId: number, deckId: number): Promise<void> {
  await db.delete(userDecks).where(and(eq(userDecks.userId, userId), eq(userDecks.deckId, deckId)));
}

export async function grantDeck(userId: number, deckId: number, paymentId?: number): Promise<void> {
  await db.insert(userDecks).values({ userId, deckId, paymentId: paymentId ?? null }).onConflictDoNothing();
}
