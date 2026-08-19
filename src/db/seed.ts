import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, sql } from './index.js';
import { deckItems, decks } from './schema.js';

interface DeckFile {
  slug: string;
  title: string;
  description: string;
  isPremium: boolean;
  priceRub: number;
  sort: number;
  items: string[];
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'decks');

const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
for (const file of files) {
  const deck = JSON.parse(await readFile(join(dir, file), 'utf8')) as DeckFile;

  const [row] = await db
    .insert(decks)
    .values({
      slug: deck.slug,
      title: deck.title,
      description: deck.description,
      isPremium: deck.isPremium,
      priceRub: deck.priceRub,
      sort: deck.sort,
    })
    .onConflictDoUpdate({
      target: decks.slug,
      set: {
        title: deck.title,
        description: deck.description,
        isPremium: deck.isPremium,
        priceRub: deck.priceRub,
        sort: deck.sort,
      },
    })
    .returning();

  await db.delete(deckItems).where(eq(deckItems.deckId, row!.id));
  await db.insert(deckItems).values(deck.items.map((text) => ({ deckId: row!.id, text })));

  console.log(`🎴 ${deck.title} — ${deck.items.length} действий${deck.isPremium ? ' 🔒' : ''}`);
}

console.log('✅ Колоды залиты');
await sql.end();
