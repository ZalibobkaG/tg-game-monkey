import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gamePlayers, userStats } from '../db/schema.js';

export interface FinishedPlayer {
  userId: number;
  seat: number;
  isMonkey: boolean;
  leftEarly: boolean;
}

/**
 * Итоги партии: состав с ролями + инкремент агрегатов игроков.
 *
 * Агрегаты именно инкрементируем (`x = x + excluded.x`), а не пересчитываем:
 * пересчёт по всей истории на каждой партии со временем станет самым
 * тяжёлым запросом в системе.
 */
export async function saveGameResult(args: {
  gameId: number;
  peasantsWon: boolean;
  players: FinishedPlayer[];
  ballots: Array<{ voterId: number; targetId: number }>;
}): Promise<void> {
  const { gameId, peasantsWon, players, ballots } = args;
  if (!players.length) return;

  const monkeys = new Set(players.filter((p) => p.isMonkey).map((p) => p.userId));
  const now = new Date();

  const deltas = players.map((p) => {
    const mine = ballots.filter((b) => b.voterId === p.userId);
    return {
      userId: p.userId,
      gamesPlayed: 1,
      gamesAsMonkey: p.isMonkey ? 1 : 0,
      winsAsMonkey: p.isMonkey && !peasantsWon ? 1 : 0,
      winsAsPeasant: !p.isMonkey && peasantsWon ? 1 : 0,
      votesCast: mine.length,
      correctVotes: mine.filter((b) => monkeys.has(b.targetId)).length,
      timesAccused: ballots.filter((b) => b.targetId === p.userId).length,
      lastGameAt: now,
    };
  });

  await db.transaction(async (tx) => {
    await tx
      .insert(gamePlayers)
      .values(players.map((p) => ({ gameId, ...p })))
      .onConflictDoUpdate({
        target: [gamePlayers.gameId, gamePlayers.userId],
        set: { leftEarly: sql`excluded.left_early` },
      });

    await tx
      .insert(userStats)
      .values(deltas)
      .onConflictDoUpdate({
        target: userStats.userId,
        set: {
          gamesPlayed: sql`${userStats.gamesPlayed} + excluded.games_played`,
          gamesAsMonkey: sql`${userStats.gamesAsMonkey} + excluded.games_as_monkey`,
          winsAsMonkey: sql`${userStats.winsAsMonkey} + excluded.wins_as_monkey`,
          winsAsPeasant: sql`${userStats.winsAsPeasant} + excluded.wins_as_peasant`,
          votesCast: sql`${userStats.votesCast} + excluded.votes_cast`,
          correctVotes: sql`${userStats.correctVotes} + excluded.correct_votes`,
          timesAccused: sql`${userStats.timesAccused} + excluded.times_accused`,
          lastGameAt: sql`excluded.last_game_at`,
        },
      });
  });
}

export async function bumpRoomsCreated(userId: number): Promise<void> {
  await db
    .insert(userStats)
    .values({ userId, roomsCreated: 1 })
    .onConflictDoUpdate({
      target: userStats.userId,
      set: { roomsCreated: sql`${userStats.roomsCreated} + 1` },
    });
}
