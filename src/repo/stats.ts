import { and, avg, count, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  decks, events, feedback, gamePlayers, games, rooms, userStats, users,
} from '../db/schema.js';
import { activeRoomOf } from './rooms.js';
import { displayName, getUserById } from './users.js';

/**
 * Слой запросов для статистики: им пользуются и `/stats` игрока, и админ-панель.
 * Только чтение и агрегаты — без отрисовки и без grammY.
 */

/** avg()/sum() и сырые SQL-агрегаты приходят строкой (или null) — приводим к числу. */
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Дата в сыром SQL. postgres.js не умеет сериализовать объект Date в параметр,
 * тип которого он не знает, — падает прямо в Bind. В запросах через билдер
 * drizzle тип берётся из колонки, а здесь его подсказать некому,
 * поэтому передаём ISO-строку с явным кастом.
 */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

// ─── сводка за период ──────────────────────────────────────────────────────

export interface PeriodStats {
  newUsers: number;
  activeUsers: number;
  roomsCreated: number;
  gamesStarted: number;
  gamesFinished: number;
  gamesAborted: number;
  avgPlayers: number;
  avgRounds: number;
  monkeyWinRate: number;
  feedbackCount: number;
}

export async function periodStats(from: Date, to: Date): Promise<PeriodStats> {
  const [{ value: newUsers } = { value: 0 }] = await db
    .select({ value: count() })
    .from(users)
    .where(and(gte(users.createdAt, from), lt(users.createdAt, to)));

  const [{ value: activeUsers } = { value: 0 }] = await db
    .select({ value: count() })
    .from(users)
    .where(and(gte(users.lastSeenAt, from), lt(users.lastSeenAt, to)));

  const [{ value: roomsCreated } = { value: 0 }] = await db
    .select({ value: count() })
    .from(rooms)
    .where(and(gte(rooms.createdAt, from), lt(rooms.createdAt, to)));

  // Партии, начатые в интервале, сразу с разбивкой по состоянию.
  const byState = await db
    .select({ state: games.state, value: count() })
    .from(games)
    .where(and(gte(games.startedAt, from), lt(games.startedAt, to)))
    .groupBy(games.state);
  const gamesStarted = byState.reduce((sum, r) => sum + r.value, 0);
  const gamesFinished = byState.find((r) => r.state === 'finished')?.value ?? 0;
  const gamesAborted = byState.find((r) => r.state === 'aborted')?.value ?? 0;

  const [{ value: avgRoundsRaw } = { value: null }] = await db
    .select({ value: avg(games.currentRound) })
    .from(games)
    .where(and(eq(games.state, 'finished'), gte(games.startedAt, from), lt(games.startedAt, to)));
  const avgRounds = round2(toNumber(avgRoundsRaw));

  // Игроков на партию — двойная агрегация (число строк game_players на игру,
  // затем среднее по играм), одной колонкой avg() тут не обойтись.
  type AvgPlayersRow = { value: string | null };
  const [avgPlayersRow] = await db.execute<AvgPlayersRow>(sql`
    select avg(cnt)::numeric as value
    from (
      select count(*) as cnt
      from ${gamePlayers}
      inner join ${games} on ${games.id} = ${gamePlayers.gameId}
      where ${games.state} = 'finished'
        and ${games.startedAt} >= ${ts(from)}
        and ${games.startedAt} < ${ts(to)}
      group by ${gamePlayers.gameId}
    ) counted
  `);
  const avgPlayers = round2(toNumber(avgPlayersRow?.value));

  // Прямого флага победы обезьянки в схеме нет — берём событие game_finished,
  // которое игровой движок пишет с payload.peasantsWon по итогам партии.
  type WinRateRow = { total: number; monkeyWins: number };
  const [winRow] = await db.execute<WinRateRow>(sql`
    select
      count(*)::int as total,
      count(*) filter (where (${events.payload}->>'peasantsWon') = 'false')::int as "monkeyWins"
    from ${events}
    where ${events.type} = 'game_finished'
      and (${events.payload}->>'peasantsWon') is not null
      and ${events.createdAt} >= ${ts(from)}
      and ${events.createdAt} < ${ts(to)}
  `);
  const winTotal = toNumber(winRow?.total);
  const monkeyWinRate = winTotal > 0 ? round2(toNumber(winRow?.monkeyWins) / winTotal) : 0;

  const [{ value: feedbackCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(feedback)
    .where(and(gte(feedback.createdAt, from), lt(feedback.createdAt, to)));

  return {
    newUsers,
    activeUsers,
    roomsCreated,
    gamesStarted,
    gamesFinished,
    gamesAborted,
    avgPlayers,
    avgRounds,
    monkeyWinRate,
    feedbackCount,
  };
}

// ─── статистика игрока ─────────────────────────────────────────────────────

export interface PlayerStats {
  gamesPlayed: number;
  gamesAsMonkey: number;
  winsAsMonkey: number;
  winsAsPeasant: number;
  votesCast: number;
  correctVotes: number;
  pointsTotal: number;
  lastGameAt: Date | null;
}

export async function playerStats(userId: number): Promise<PlayerStats> {
  const [row] = await db.select().from(userStats).where(eq(userStats.userId, userId)).limit(1);
  if (!row) {
    return {
      gamesPlayed: 0,
      gamesAsMonkey: 0,
      winsAsMonkey: 0,
      winsAsPeasant: 0,
      votesCast: 0,
      correctVotes: 0,
      pointsTotal: 0,
      lastGameAt: null,
    };
  }
  return {
    gamesPlayed: row.gamesPlayed,
    gamesAsMonkey: row.gamesAsMonkey,
    winsAsMonkey: row.winsAsMonkey,
    winsAsPeasant: row.winsAsPeasant,
    votesCast: row.votesCast,
    correctVotes: row.correctVotes,
    pointsTotal: row.pointsTotal,
    lastGameAt: row.lastGameAt,
  };
}

// ─── использование колод ───────────────────────────────────────────────────

export interface DeckUsage {
  deckId: number;
  slug: string;
  title: string;
  games: number;
  lockedHits: number;
}

export async function deckUsage(from: Date, to: Date): Promise<DeckUsage[]> {
  // LEFT JOIN с условием периода прямо в ON — иначе колоды без партий в
  // интервале выпадут из выборки вместо того, чтобы дать games = 0.
  const byDeck = await db
    .select({
      deckId: decks.id,
      slug: decks.slug,
      title: decks.title,
      games: count(games.id),
    })
    .from(decks)
    .leftJoin(games, and(eq(games.deckId, decks.id), gte(games.startedAt, from), lt(games.startedAt, to)))
    .groupBy(decks.id, decks.slug, decks.title);

  type LockedHitRow = { slug: string; hits: number };
  const lockedRows = await db.execute<LockedHitRow>(sql`
    select (${events.payload}->>'deckSlug') as slug, count(*)::int as hits
    from ${events}
    where ${events.type} = 'deck_locked_hit'
      and (${events.payload}->>'deckSlug') is not null
      and ${events.createdAt} >= ${ts(from)}
      and ${events.createdAt} < ${ts(to)}
    group by (${events.payload}->>'deckSlug')
  `);
  const lockedBySlug = new Map(lockedRows.map((r) => [r.slug, toNumber(r.hits)]));

  return byDeck
    .map((d) => ({ ...d, lockedHits: lockedBySlug.get(d.slug) ?? 0 }))
    .sort((a, b) => b.games - a.games);
}

// ─── здоровье сигнала (разброс времени реакции) ────────────────────────────

export interface SignalHealth {
  samples: number;
  medianMs: number;
  p95Ms: number;
}

export async function signalHealth(from: Date, to: Date): Promise<SignalHealth> {
  type Row = { samples: number; median: string | null; p95: string | null };
  const [row] = await db.execute<Row>(sql`
    select
      count(*)::int as samples,
      (percentile_cont(0.5) within group (order by (${events.payload}->>'dispersionMs')::numeric))::numeric as median,
      (percentile_cont(0.95) within group (order by (${events.payload}->>'dispersionMs')::numeric))::numeric as p95
    from ${events}
    where ${events.type} = 'round_played'
      and (${events.payload}->>'dispersionMs') is not null
      and ${events.createdAt} >= ${ts(from)}
      and ${events.createdAt} < ${ts(to)}
  `);

  return {
    samples: toNumber(row?.samples),
    medianMs: round2(toNumber(row?.median)),
    p95Ms: round2(toNumber(row?.p95)),
  };
}

// ─── админка: карточка пользователя, поиск, лидерборд ──────────────────────

export interface UserCard {
  user: typeof users.$inferSelect;
  stats: PlayerStats;
  feedbackCount: number;
  activeRoomCode: string | null;
}

export async function userCard(userId: number): Promise<UserCard | null> {
  const user = await getUserById(userId);
  if (!user) return null;

  const [stats, feedbackRows, room] = await Promise.all([
    playerStats(userId),
    db.select({ value: count() }).from(feedback).where(eq(feedback.userId, userId)),
    activeRoomOf(userId),
  ]);
  const [{ value: feedbackCount } = { value: 0 }] = feedbackRows;

  return { user, stats, feedbackCount, activeRoomCode: room?.code ?? null };
}

/** Поиск для админки: числовая строка ищет по tg_id и id, иначе — по username/имени. */
export async function findUsers(query: string, limit = 10): Promise<Array<typeof users.$inferSelect>> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return db.select().from(users).where(or(eq(users.tgId, n), eq(users.id, n))).limit(limit);
  }

  const handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  const pattern = `%${handle}%`;
  return db
    .select()
    .from(users)
    .where(or(ilike(users.username, pattern), ilike(users.firstName, pattern)))
    .limit(limit);
}

export async function topPlayers(
  limit = 10,
): Promise<Array<{ userId: number; name: string; gamesPlayed: number; pointsTotal: number }>> {
  const rows = await db
    .select({ user: users, gamesPlayed: userStats.gamesPlayed, pointsTotal: userStats.pointsTotal })
    .from(userStats)
    .innerJoin(users, eq(users.id, userStats.userId))
    .orderBy(desc(userStats.pointsTotal))
    .limit(limit);

  return rows.map((r) => ({
    userId: r.user.id,
    name: displayName(r.user),
    gamesPlayed: r.gamesPlayed,
    pointsTotal: r.pointsTotal,
  }));
}

// ─── лента событий для журнала панели ──────────────────────────────────────

export interface EventRow {
  id: number;
  type: string;
  createdAt: Date;
  userId: number | null;
  roomId: number | null;
  gameId: number | null;
  payload: Record<string, unknown>;
  /** имя того, кто вызвал событие; null — если пользователь удалён или события системные */
  actorName: string | null;
}

export async function recentEvents(args: { types?: string[]; limit?: number } = {}): Promise<EventRow[]> {
  const { types, limit = 25 } = args;
  const rows = await db
    .select({ e: events, firstName: users.firstName, username: users.username })
    .from(events)
    .leftJoin(users, eq(users.id, events.userId))
    .where(types && types.length ? inArray(events.type, types) : undefined)
    .orderBy(desc(events.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.e.id,
    type: r.e.type,
    createdAt: r.e.createdAt,
    userId: r.e.userId,
    roomId: r.e.roomId,
    gameId: r.e.gameId,
    payload: r.e.payload,
    actorName: r.firstName?.trim() || (r.username ? `@${r.username}` : null),
  }));
}
