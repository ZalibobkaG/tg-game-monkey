import * as R from '../repo/rooms.js';
import { decksFor, getDeck } from '../repo/decks.js';
import { getWallet } from '../repo/wallet.js';
import { playerStats } from '../repo/stats.js';
import { getEconomy } from '../repo/settings.js';
import { displayName } from '../repo/users.js';
import type { User } from '../repo/users.js';
import { RULES, canStart, maxRounds } from '../domain/rules.js';
import { COIN } from '../domain/economy.js';
import { deepLink } from '../config.js';
import { activeSlots, canSkipVote, getLive, isVoteTime, lastResult, slotOf } from '../services/game.js';
import type { LiveGame } from '../services/game.js';

/**
 * Снимок состояния для мини-аппа.
 *
 * Мини-апп не держит своего состояния: он раз в секунду просит этот объект
 * и перерисовывает экран целиком. Так проще всего не разъехаться с ботом —
 * а разъехаться есть с чем: те же комнаты и партии живут в чате параллельно,
 * и любая попытка вести две копии истины закончилась бы игроком, который
 * в чате уже проголосовал, а в приложении ещё нет.
 *
 * Что сюда НЕ попадает: чужие роли до финала и номер действия до сигнала.
 * Всё, что уехало в браузер, считается раскрытым — пусть даже мы это
 * не нарисовали.
 */

export interface WebAppState {
  /** отпечаток снимка: не изменился — клиент не трогает DOM */
  rev: string;
  me: {
    userId: number;
    tgId: number;
    name: string;
    username: string | null;
  };
  wallet: { balance: number; coin: string };
  stats: {
    gamesPlayed: number;
    gamesAsMonkey: number;
    wins: number;
    votesCast: number;
    correctVotes: number;
  };
  rules: {
    minPlayers: number;
    maxPlayers: number;
    cardSize: number;
    maxRounds: number;
    voteEveryOptions: number[];
  };
  decks: Array<{
    id: number;
    slug: string;
    title: string;
    description: string;
    isPremium: boolean;
    owned: boolean;
    active: boolean;
    priceStars: number;
    priceCoins: number;
    priceRub: number;
  }>;
  providers: { stars: boolean; wallet: boolean };
  room: RoomView | null;
  game: GameView | null;
  result: ResultView | null;
}

export interface RoomView {
  id: number;
  code: string;
  link: string;
  state: 'lobby' | 'playing' | 'closed';
  locked: boolean;
  voteEvery: number;
  deckId: number | null;
  deckTitle: string | null;
  isAdmin: boolean;
  /** можно ли жать «Начать»; иначе в `startError` лежит причина */
  canStart: boolean;
  startError: string | null;
  members: Array<{
    userId: number;
    name: string;
    seat: number;
    isMe: boolean;
    isAdmin: boolean;
    /** бот не может писать ему в личку — с ним игра не начнётся */
    dmOk: boolean;
  }>;
}

export interface GameView {
  gameId: number;
  phase: 'waiting' | 'countdown' | 'revealed' | 'voting' | 'finished';
  round: number;
  maxRounds: number;
  isAdmin: boolean;
  isMonkey: boolean;
  /** 10 действий; у обезьянки — null, она списка не знает */
  card: string[] | null;
  /** когда закончится отсчёт, epoch ms; клиент рисует 3-2-1 сам */
  revealAt: number | null;
  /** номер действия — только после сигнала и только мирным */
  revealedNumber: number | null;
  /** следующее действие ведущего: голосование, а не раунд */
  nextIsVote: boolean;
  players: Array<{ userId: number; name: string; dropped: boolean; isMe: boolean }>;
  voting: {
    revote: boolean;
    candidates: Array<{ userId: number; name: string }>;
    myVote: number | null;
    mySkipped: boolean;
    canSkip: boolean;
    answered: number;
    total: number;
  } | null;
}

export interface ResultView {
  gameId: number;
  peasantsWon: boolean | null;
  monkeyNames: string[];
  rounds: number;
  reason: string;
  at: number;
}

function gameView(game: LiveGame, userId: number): GameView | null {
  const me = slotOf(game, userId);
  if (!me) return null;

  const revealed = game.phase === 'revealed' || game.phase === 'voting';
  const actionIndex = game.currentRound > 0 ? game.actionOrder[game.currentRound - 1] : undefined;
  const alive = activeSlots(game);

  const voting =
    game.phase === 'voting'
      ? {
          revote: game.shortlist !== null,
          candidates: alive
            .filter((p) => p.userId !== userId && (!game.shortlist || game.shortlist.includes(p.userId)))
            .map((p) => ({ userId: p.userId, name: p.name })),
          myVote: game.votes.get(userId) ?? null,
          mySkipped: game.skipped.has(userId),
          canSkip: canSkipVote(game),
          answered: alive.filter((p) => game.votes.has(p.userId) || game.skipped.has(p.userId)).length,
          total: alive.length,
        }
      : null;

  return {
    gameId: game.gameId,
    phase: game.phase,
    round: game.currentRound,
    maxRounds,
    isAdmin: game.adminUserId === userId,
    isMonkey: me.isMonkey,
    card: me.isMonkey ? null : game.actions,
    revealAt: game.phase === 'countdown' ? game.revealAt : null,
    // Номер уходит в браузер только после сигнала: до него он лежал бы
    // в ответе API, и обезьянке хватило бы вкладки «Сеть», чтобы выиграть.
    revealedNumber: revealed && !me.isMonkey && actionIndex !== undefined ? actionIndex + 1 : null,
    nextIsVote: isVoteTime(game) && !game.ballotDone,
    players: game.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      dropped: p.dropped,
      isMe: p.userId === userId,
    })),
    voting,
  };
}

async function roomView(room: R.Room, user: User): Promise<RoomView> {
  const members = await R.listMembers(room.id);
  const deck = room.deckId ? await getDeck(room.deckId) : undefined;
  const isAdmin = room.adminUserId === user.id;

  const check = canStart(members.length);
  const noDm = members.filter((m) => !m.dmOk).map((m) => displayName(m.user));
  const startError = !check.ok
    ? check.reason
    : noDm.length
      ? `Бот не может писать в личку: ${noDm.join(', ')}. Пусть нажмут /start у бота.`
      : !deck
        ? 'Сначала выбери колоду'
        : null;

  return {
    id: room.id,
    code: room.code,
    link: deepLink(room.code),
    state: room.state,
    locked: room.locked,
    voteEvery: room.voteEvery,
    deckId: room.deckId,
    deckTitle: deck?.title ?? null,
    isAdmin,
    canStart: isAdmin && startError === null,
    startError,
    members: members.map((m) => ({
      userId: m.userId,
      name: displayName(m.user),
      seat: m.seat,
      isMe: m.userId === user.id,
      isAdmin: m.userId === room.adminUserId,
      dmOk: m.dmOk,
    })),
  };
}

/** Дешёвый отпечаток снимка: сравниваем строки, а не объекты. */
function revisionOf(state: Omit<WebAppState, 'rev'>): string {
  return JSON.stringify([state.room, state.game, state.result, state.wallet, state.decks.map((d) => d.owned)]);
}

export async function buildState(user: User): Promise<WebAppState> {
  const [wallet, stats, decks, economy] = await Promise.all([
    getWallet(user.id),
    playerStats(user.id),
    decksFor(user.id),
    getEconomy(),
  ]);

  const room = await R.activeRoomOf(user.id);
  const live = room ? getLive(room.id) : undefined;
  const finished = room ? lastResult(room.id) : undefined;

  const partial: Omit<WebAppState, 'rev'> = {
    me: {
      userId: user.id,
      tgId: user.tgId,
      name: displayName(user),
      username: user.username,
    },
    wallet: { balance: wallet.balance, coin: COIN },
    stats: {
      gamesPlayed: stats.gamesPlayed,
      gamesAsMonkey: stats.gamesAsMonkey,
      wins: stats.winsAsMonkey + stats.winsAsPeasant,
      votesCast: stats.votesCast,
      correctVotes: stats.correctVotes,
    },
    rules: {
      minPlayers: RULES.minPlayers,
      maxPlayers: RULES.maxPlayers,
      cardSize: RULES.cardSize,
      maxRounds,
      voteEveryOptions: [...RULES.voteEveryOptions],
    },
    decks: decks
      .filter((d) => d.active || d.owned)
      .map((d) => ({
        id: d.id,
        slug: d.slug,
        title: d.title,
        description: d.description,
        isPremium: d.isPremium,
        owned: d.owned,
        active: d.active,
        priceStars: d.priceStars,
        priceCoins: d.priceCoins,
        priceRub: d.priceRub,
      })),
    providers: { stars: economy.providers.stars, wallet: economy.providers.wallet },
    room: room ? await roomView(room, user) : null,
    game: live ? gameView(live, user.id) : null,
    // Итог показываем минуту: дальше это уже не новость, а мусор на экране.
    result: finished && Date.now() - finished.at < 60_000
      ? {
          gameId: finished.gameId,
          peasantsWon: finished.peasantsWon,
          monkeyNames: finished.monkeyNames,
          rounds: finished.rounds,
          reason: finished.reason,
          at: finished.at,
        }
      : null,
  };

  return { ...partial, rev: revisionOf(partial) };
}
