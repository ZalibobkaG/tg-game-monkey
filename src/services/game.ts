import { Api, GrammyError, InlineKeyboard } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games, rounds } from '../db/schema.js';
import * as R from '../repo/rooms.js';
import { displayName } from '../repo/users.js';
import { deal, sleep } from '../domain/game.js';
import { RULES } from '../domain/rules.js';
import * as UI from '../ui/game.js';

export interface Slot {
  userId: number;
  tgId: number;
  name: string;
  isMonkey: boolean;
  cardMessageId: number;
  signalMessageId: number;
}

export type Phase = 'waiting' | 'countdown' | 'revealed' | 'finished';

export interface LiveGame {
  gameId: number;
  roomId: number;
  code: string;
  adminUserId: number;
  actions: string[];
  actionOrder: number[];
  roundsCount: number;
  /** 0 — ещё не начинали */
  currentRound: number;
  phase: Phase;
  players: Slot[];
  /** защита от двойных нажатий, пока идёт отсчёт */
  busy: boolean;
}

const live = new Map<number, LiveGame>();
const hideTimers = new Map<string, NodeJS.Timeout>();

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
        await api.editMessageText(p.tgId, p.signalMessageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (e) {
        if (!ignorable(e)) console.error('signal edit:', e);
      }
    }),
  );
}

const adminOnly = (game: LiveGame, p: Slot, kb: InlineKeyboard): InlineKeyboard | undefined =>
  p.userId === game.adminUserId ? kb : undefined;

// ─── старт ────────────────────────────────────────────────────────────────

export async function startGame(
  api: Api,
  room: R.Room,
  members: R.Member[],
  deckActions: string[],
): Promise<LiveGame> {
  const d = deal(deckActions, members.map((m) => m.userId), room.roundsCount);

  const [row] = await db
    .insert(games)
    .values({
      roomId: room.id,
      deckId: room.deckId!,
      actions: d.actions,
      monkeyUserIds: d.monkeyUserIds,
      actionOrder: d.actionOrder,
      roundsCount: d.actionOrder.length,
      currentRound: 0,
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
  const total = d.actionOrder.length;

  const players = await Promise.all(
    members.map(async (m): Promise<Slot> => {
      const isAdmin = m.userId === room.adminUserId;
      const card = await api.sendMessage(m.user.tgId, UI.renderCardHidden(room.code), {
        parse_mode: 'HTML',
        reply_markup: UI.showCardKeyboard(),
      });
      const signal = await api.sendMessage(m.user.tgId, UI.renderWaiting(1, total, isAdmin), {
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
    roundsCount: total,
    currentRound: 0,
    phase: 'waiting',
    players,
    busy: false,
  };
  live.set(room.id, game);
  return game;
}

// ─── карточка ─────────────────────────────────────────────────────────────

/** Показывает карточку и прячет её обратно через несколько секунд. */
export async function revealCard(api: Api, game: LiveGame, slot: Slot): Promise<void> {
  const key = `${game.roomId}:${slot.userId}`;
  clearTimeout(hideTimers.get(key));

  await api
    .editMessageText(slot.tgId, slot.cardMessageId, UI.renderCardOpen(game.actions, slot.isMonkey), {
      parse_mode: 'HTML',
    })
    .catch((e) => {
      if (!ignorable(e)) throw e;
    });

  const timer = setTimeout(() => {
    hideTimers.delete(key);
    void api
      .editMessageText(slot.tgId, slot.cardMessageId, UI.renderCardHidden(game.code), {
        parse_mode: 'HTML',
        reply_markup: UI.showCardKeyboard(),
      })
      .catch(() => {});
  }, RULES.cardRevealSeconds * 1000);

  hideTimers.set(key, timer);
}

function dropTimers(game: LiveGame): void {
  for (const p of game.players) {
    const key = `${game.roomId}:${p.userId}`;
    clearTimeout(hideTimers.get(key));
    hideTimers.delete(key);
  }
}

// ─── раунд ────────────────────────────────────────────────────────────────

export async function runRound(api: Api, roomId: number): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.busy || game.phase === 'countdown' || game.phase === 'finished') return;
  if (game.currentRound >= game.roundsCount) return;

  game.busy = true;
  try {
    game.currentRound += 1;
    game.phase = 'countdown';
    const round = game.currentRound;
    const actionIndex = game.actionOrder[round - 1]!;

    await db.insert(rounds).values({ gameId: game.gameId, idx: round, actionIndex }).onConflictDoNothing();
    await db.update(games).set({ currentRound: round }).where(eq(games.id, game.gameId));

    // отсчёт: кнопки сняты, все смотрят в экран
    for (let left = RULES.countdownSeconds; left >= 1; left--) {
      await editSignals(api, game, () => ({ text: UI.renderCountdown(round, game.roundsCount, left) }));
      await sleep(1000);
    }

    const isLast = round >= game.roundsCount;
    await editSignals(api, game, (p) => ({
      text: UI.renderReveal(round, game.roundsCount, actionIndex + 1, p.isMonkey),
      keyboard: adminOnly(game, p, UI.afterRoundKeyboard(isLast)),
    }));
    game.phase = 'revealed';
  } finally {
    game.busy = false;
  }
}

// ─── финал ────────────────────────────────────────────────────────────────

export async function finishGame(api: Api, roomId: number): Promise<void> {
  const game = live.get(roomId);
  if (!game || game.phase === 'finished') return;
  game.phase = 'finished';
  dropTimers(game);

  await db.update(games).set({ state: 'finished', endedAt: new Date() }).where(eq(games.id, game.gameId));

  const text = UI.renderFinal({
    monkeyNames: game.players.filter((p) => p.isMonkey).map((p) => p.name),
    actions: game.actions,
    playedNumbers: game.actionOrder.slice(0, game.currentRound),
  });

  await editSignals(api, game, (p) => ({ text, keyboard: adminOnly(game, p, UI.againKeyboard()) }));

  await Promise.all(
    game.players.map((p) =>
      api
        .editMessageText(p.tgId, p.cardMessageId, UI.renderCardFinal(game.actions, p.isMonkey), {
          parse_mode: 'HTML',
        })
        .catch(() => {}),
    ),
  );

  await R.clearGameMessages(roomId);
  await R.setState(roomId, 'lobby');
  live.delete(roomId);
}

export async function abortGame(api: Api, roomId: number, reason: string): Promise<void> {
  const game = live.get(roomId);
  if (!game) return;
  game.phase = 'finished';
  dropTimers(game);

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
      roundsCount: g.roundsCount,
      currentRound: g.currentRound,
      phase: g.currentRound >= g.roundsCount ? 'revealed' : 'waiting',
      players: ready.map((m) => ({
        userId: m.userId,
        tgId: m.user.tgId,
        name: displayName(m.user),
        isMonkey: monkeys.has(m.userId),
        cardMessageId: m.cardMessageId!,
        signalMessageId: m.signalMessageId!,
      })),
      busy: false,
    };
    live.set(g.roomId, game);

    const isLast = game.currentRound >= game.roundsCount;
    const nextRound = Math.min(game.currentRound + 1, game.roundsCount);
    await editSignals(api, game, (p) => ({
      text:
        '♻️ <b>Бот перезапустился</b>\n\n' +
        (isLast
          ? 'Все раунды сыграны — админ, жми «Итог».'
          : `Продолжаем с раунда ${nextRound} из ${game.roundsCount}.`),
      keyboard: adminOnly(game, p, isLast ? UI.afterRoundKeyboard(true) : UI.goKeyboard(nextRound)),
    }));

    console.log(`♻️ восстановлена игра ${g.id} в комнате ${room.code} (раунд ${g.currentRound}/${g.roundsCount})`);
  }
}
