import { Api, GrammyError, InlineKeyboard } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games, rounds, votes } from '../db/schema.js';
import * as R from '../repo/rooms.js';
import { displayName } from '../repo/users.js';
import { deal, resolveBallot, scoreGame, sleep } from '../domain/game.js';
import { RULES, maxRounds } from '../domain/rules.js';
import * as UI from '../ui/game.js';

export interface Slot {
  userId: number;
  tgId: number;
  name: string;
  isMonkey: boolean;
  cardMessageId: number;
  signalMessageId: number;
}

export type Phase = 'waiting' | 'countdown' | 'revealed' | 'voting' | 'finished';

export interface LiveGame {
  gameId: number;
  roomId: number;
  code: string;
  adminUserId: number;
  actions: string[];
  actionOrder: number[];
  voteEvery: number;
  currentRound: number;
  phase: Phase;
  players: Slot[];
  busy: boolean;
  /** номер бюллетеня; 0 — голосований ещё не было */
  ballot: number;
  /** голоса текущего бюллетеня: избиратель → кандидат */
  votes: Map<number, number>;
  /** ограниченный список кандидатов при переголосовании */
  shortlist: number[] | null;
}

const live = new Map<number, LiveGame>();

export const getLive = (roomId: number): LiveGame | undefined => live.get(roomId);
export const slotOf = (game: LiveGame, userId: number): Slot | undefined =>
  game.players.find((p) => p.userId === userId);

function ignorable(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    (e.error_code === 403 ||
      e.description.includes('message is not modified') ||
      e.description.includes('message to edit not found') ||
      e.description.includes('MESSAGE_ID_INVALID'))
  );
}

/** Правка сообщения-сигнала у всех сразу. Единственное место, где важна синхронность. */
async function editSignals(
  api: Api,
  game: LiveGame,
  render: (p: Slot) => { text: string; keyboard?: InlineKeyboard },
): Promise<void> {
  await Promise.all(
    game.players.map(async (p) => {
      const { text, keyboard } = render(p);
      try {
        await api.editMessageText(p.tgId, p.signalMessageId, text, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (e) {
        if (!ignorable(e)) console.error('signal edit:', e);
      }
    }),
  );
}

const adminOnly = (game: LiveGame, p: Slot, kb: InlineKeyboard): InlineKeyboard | undefined =>
  p.userId === game.adminUserId ? kb : undefined;

const nameOf = (game: LiveGame, userId: number): string =>
  game.players.find((p) => p.userId === userId)?.name ?? 'Игрок';

// ─── старт ────────────────────────────────────────────────────────────────

export async function startGame(
  api: Api,
  room: R.Room,
  members: R.Member[],
  deckActions: string[],
): Promise<LiveGame> {
  const d = deal(deckActions, members.map((m) => m.userId));

  const [row] = await db
    .insert(games)
    .values({
      roomId: room.id,
      deckId: room.deckId!,
      actions: d.actions,
      monkeyUserIds: d.monkeyUserIds,
      actionOrder: d.actionOrder,
      voteEvery: room.voteEvery,
      currentRound: 0,
      ballot: 0,
      state: 'playing',
    })
    .returning();

  await R.setState(room.id, 'playing');

  // лобби больше не нужно — его место занимают карточка и сигнал
  await Promise.all(
    members.map(async (m) => {
      if (m.lobbyMessageId) await api.deleteMessage(m.user.tgId, m.lobbyMessageId).catch(() => {});
      await R.setLobbyMessage(room.id, m.userId, null);
    }),
  );

  const monkeys = new Set(d.monkeyUserIds);

  const players = await Promise.all(
    members.map(async (m): Promise<Slot> => {
      const isAdmin = m.userId === room.adminUserId;
      const card = await api.sendMessage(
        m.user.tgId,
        UI.renderCard(room.code, d.actions, monkeys.has(m.userId)),
        { parse_mode: 'HTML' },
      );
      const signal = await api.sendMessage(m.user.tgId, UI.renderWaiting(1, isAdmin), {
        parse_mode: 'HTML',
        reply_markup: isAdmin ? UI.goKeyboard(1) : undefined,
      });
      await R.setGameMessages(room.id, m.userId, card.message_id, signal.message_id);
      return {
        userId: m.userId,
        tgId: m.user.tgId,
        name: displayName(m.user),
        isMonkey: monkeys.has(m.userId),
        cardMessageId: card.message_id,
        signalMessageId: signal.message_id,
      };
    }),
  );

  const game: LiveGame = {
    gameId: row!.id,
    roomId: room.id,
    code: room.code,
    adminUserId: room.adminUserId,
    actions: d.actions,
    actionOrder: d.actionOrder,
    voteEvery: room.voteEvery,
    currentRound: 0,
    phase: 'waiting',
    players,
    busy: false,
    ballot: 0,
    votes: new Map(),
    shortlist: null,
  };
  live.set(room.id, game);
  return game;
}

// ─── раунд ────────────────────────────────────────────────────────────────

/** Пора ли голосовать: отыграли кратное число раундов или кончилась карточка. */
export function isVoteTime(game: LiveGame): boolean {
  return game.currentRound % game.voteEvery === 0 || game.currentRound >= maxRounds;
}

export async function runRound(api: Api, roomId: number): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.busy) return;
  if (game.phase === 'countdown' || game.phase === 'voting' || game.phase === 'finished') return;
  if (game.currentRound >= maxRounds) return;

  game.busy = true;
  try {
    game.currentRound += 1;
    game.phase = 'countdown';
    const round = game.currentRound;
    const actionIndex = game.actionOrder[round - 1]!;

    await db.insert(rounds).values({ gameId: game.gameId, idx: round, actionIndex }).onConflictDoNothing();
    await db.update(games).set({ currentRound: round }).where(eq(games.id, game.gameId));

    for (let left = RULES.countdownSeconds; left >= 1; left--) {
      await editSignals(api, game, () => ({ text: UI.renderCountdown(round, left) }));
      await sleep(1000);
    }

    const voteTime = isVoteTime(game);
    await editSignals(api, game, (p) => ({
      text: UI.renderReveal(round, actionIndex + 1, p.isMonkey),
      keyboard: adminOnly(game, p, UI.afterRoundKeyboard(voteTime)),
    }));
    game.phase = 'revealed';
  } finally {
    game.busy = false;
  }
}

// ─── голосование ──────────────────────────────────────────────────────────

function candidatesFor(game: LiveGame, voter: Slot): UI.Candidate[] {
  const allowed = game.shortlist;
  return game.players
    .filter((p) => p.userId !== voter.userId && (!allowed || allowed.includes(p.userId)))
    .map((p) => ({ userId: p.userId, name: p.name }));
}

async function paintVoting(api: Api, game: LiveGame): Promise<void> {
  const total = game.players.length;
  const voted = game.votes.size;
  await editSignals(api, game, (p) => {
    const myTarget = game.votes.get(p.userId);
    return UI.renderVoting({
      round: game.currentRound,
      revote: game.shortlist !== null,
      candidates: candidatesFor(game, p),
      myVoteName: myTarget === undefined ? undefined : nameOf(game, myTarget),
      voted,
      total,
    });
  });
}

export async function startVoting(api: Api, roomId: number, shortlist: number[] | null = null): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.busy || game.phase === 'finished') return;

  game.phase = 'voting';
  game.ballot += 1;
  game.votes.clear();
  game.shortlist = shortlist;

  await db.update(games).set({ ballot: game.ballot, state: shortlist ? 'revote' : 'voting' }).where(eq(games.id, game.gameId));
  await paintVoting(api, game);
}

export async function castVote(api: Api, roomId: number, voterId: number, targetId: number): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.phase !== 'voting') return;
  if (voterId === targetId) return;
  if (game.shortlist && !game.shortlist.includes(targetId)) return;
  if (!slotOf(game, targetId) || !slotOf(game, voterId)) return;

  game.votes.set(voterId, targetId);
  await db
    .insert(votes)
    .values({ gameId: game.gameId, ballot: game.ballot, voterId, targetId })
    .onConflictDoUpdate({
      target: [votes.gameId, votes.ballot, votes.voterId],
      set: { targetId },
    });

  if (game.votes.size < game.players.length) {
    await paintVoting(api, game);
    return;
  }
  await tally(api, game);
}

async function tally(api: Api, game: LiveGame): Promise<void> {
  const counts = new Map<number, number>();
  for (const target of game.votes.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
  const table = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, n]) => ({ name: nameOf(game, userId), votes: n }));

  const outcome = resolveBallot(game.votes, game.shortlist !== null);

  if (outcome.kind === 'revote') {
    await startVoting(api, game.roomId, outcome.leaders);
    return;
  }

  if (outcome.kind === 'tie') {
    game.shortlist = null;
    game.phase = 'revealed';
    await afterFailedVote(api, game, UI.renderTie(table));
    return;
  }

  const caught = slotOf(game, outcome.userId)!.isMonkey;
  const text = UI.renderVoteResult({ counts: table, accusedName: nameOf(game, outcome.userId), caught });
  game.shortlist = null;

  if (caught) {
    await finishGame(api, game.roomId, true, text);
    return;
  }
  game.phase = 'revealed';
  await afterFailedVote(api, game, text);
}

/** Обезьянку не поймали: либо играем дальше, либо карточка кончилась и она победила. */
async function afterFailedVote(api: Api, game: LiveGame, resultText: string): Promise<void> {
  if (game.currentRound >= maxRounds) {
    await finishGame(api, game.roomId, false, resultText);
    return;
  }
  await editSignals(api, game, (p) => ({
    text: `${resultText}\n\n<i>Раундов сыграно ${game.currentRound} из ${maxRounds}.</i>`,
    keyboard: adminOnly(game, p, UI.afterRoundKeyboard(false)),
  }));
}

// ─── очки и финал ─────────────────────────────────────────────────────────

async function computeScores(game: LiveGame, peasantsWon: boolean): Promise<Array<{ name: string; points: number }>> {
  const ballots = await db.select().from(votes).where(eq(votes.gameId, game.gameId));
  const points = scoreGame({ players: game.players, ballots, peasantsWon });
  return game.players
    .map((p) => ({ name: p.name, points: points.get(p.userId) ?? 0 }))
    .sort((a, b) => b.points - a.points);
}

export async function finishGame(
  api: Api,
  roomId: number,
  peasantsWon: boolean,
  prefix = '',
): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.phase === 'finished') return;
  game.phase = 'finished';

  await db.update(games).set({ state: 'finished', endedAt: new Date() }).where(eq(games.id, game.gameId));

  const scores = await computeScores(game, peasantsWon);
  const final = UI.renderFinal({
    peasantsWon,
    monkeyNames: game.players.filter((p) => p.isMonkey).map((p) => p.name),
    scores,
    rounds: game.currentRound,
    ballots: game.ballot,
  });
  const text = prefix ? `${prefix}\n\n${final}` : final;

  await editSignals(api, game, (p) => ({ text, keyboard: adminOnly(game, p, UI.againKeyboard()) }));

  await R.clearGameMessages(roomId);
  await R.setState(roomId, 'lobby');
  live.delete(roomId);
}

export async function abortGame(api: Api, roomId: number, reason: string): Promise<void> {
  const game = live.get(roomId);
  if (!game) return;
  game.phase = 'finished';

  await db.update(games).set({ state: 'aborted', endedAt: new Date() }).where(eq(games.id, game.gameId));
  await editSignals(api, game, () => ({ text: UI.renderAborted(reason) }));
  await Promise.all(game.players.map((p) => api.deleteMessage(p.tgId, p.cardMessageId).catch(() => {})));

  await R.clearGameMessages(roomId);
  await R.setState(roomId, 'lobby');
  live.delete(roomId);
}

// ─── восстановление после перезапуска ─────────────────────────────────────

export async function recoverGames(api: Api): Promise<void> {
  const rows = await db.select().from(games).where(eq(games.state, 'playing'));
  if (!rows.length) return;

  for (const g of rows) {
    const room = await R.getRoom(g.roomId);
    const members = await R.listMembers(g.roomId);
    const ready = members.filter((m) => m.cardMessageId && m.signalMessageId);

    if (!room || room.state === 'closed' || ready.length < RULES.minPlayers) {
      await db.update(games).set({ state: 'aborted', endedAt: new Date() }).where(eq(games.id, g.id));
      await R.clearGameMessages(g.roomId);
      if (room && room.state !== 'closed') await R.setState(g.roomId, 'lobby');
      continue;
    }

    const monkeys = new Set(g.monkeyUserIds);
    const game: LiveGame = {
      gameId: g.id,
      roomId: g.roomId,
      code: room.code,
      adminUserId: room.adminUserId,
      actions: g.actions,
      actionOrder: g.actionOrder,
      voteEvery: g.voteEvery,
      currentRound: g.currentRound,
      phase: 'revealed',
      players: ready.map((m) => ({
        userId: m.userId,
        tgId: m.user.tgId,
        name: displayName(m.user),
        isMonkey: monkeys.has(m.userId),
        cardMessageId: m.cardMessageId!,
        signalMessageId: m.signalMessageId!,
      })),
      busy: false,
      ballot: g.ballot,
      votes: new Map(),
      shortlist: null,
    };
    live.set(g.roomId, game);

    // незакрытое голосование продолжать нельзя — возвращаем к раундам
    const voteTime = game.currentRound > 0 && isVoteTime(game);
    await editSignals(api, game, (p) => ({
      text:
        '♻️ <b>Бот перезапустился</b>\n\n' +
        (game.currentRound === 0
          ? 'Игра ещё не начиналась — админ, жми «Погнали».'
          : `Сыграно ${game.currentRound} из ${maxRounds} раундов.` +
            (voteTime ? '\nМожно голосовать.' : '')),
      keyboard: adminOnly(
        game,
        p,
        game.currentRound === 0 ? UI.goKeyboard(1) : UI.afterRoundKeyboard(voteTime),
      ),
    }));

    console.log(`♻️ восстановлена игра ${g.id} в комнате ${room.code} (раунд ${g.currentRound}/${maxRounds})`);
  }
}
