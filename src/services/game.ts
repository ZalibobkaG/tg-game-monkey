import { Api, GrammyError, InlineKeyboard } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { games, rounds, votes } from '../db/schema.js';
import * as R from '../repo/rooms.js';
import { displayName } from '../repo/users.js';
import { deal, resolveBallot, scoreGame, sleep } from '../domain/game.js';
import { RULES, maxRounds } from '../domain/rules.js';
import { withRoomLock } from '../lib/mutex.js';
import { createDebouncer } from '../lib/debounce.js';
import { saveGameResult } from '../repo/gameStats.js';
import { track, trackBotBlocked, trackGameFinished, trackGameStarted, trackRoundPlayed } from './analytics.js';
import * as UI from '../ui/game.js';
import { log, roomLog } from '../lib/log.js';

export interface Slot {
  userId: number;
  tgId: number;
  seat: number;
  name: string;
  isMonkey: boolean;
  cardMessageId: number;
  signalMessageId: number;
  /** игрок недоступен (заблокировал бота, удалил аккаунт) — не ждём его и не пишем ему */
  dropped: boolean;
  /** отпечаток последней отрисовки: не тратим вызов API, если ничего не изменилось */
  lastPaint: string;
}

export type Phase = 'waiting' | 'countdown' | 'revealed' | 'voting' | 'finished';

export interface LiveGame {
  gameId: number;
  roomId: number;
  code: string;
  adminUserId: number;
  actions: string[];
  actionOrder: number[];
  deckSlug: string;
  voteEvery: number;
  currentRound: number;
  phase: Phase;
  players: Slot[];
  /** номер бюллетеня; 0 — голосований ещё не было */
  ballot: number;
  /** голоса текущего бюллетеня: избиратель → кандидат */
  votes: Map<number, number>;
  /** ограниченный список кандидатов при переголосовании */
  shortlist: number[] | null;
  /** метка последнего действия — по ней janitor добивает брошенные партии */
  lastActivity: number;
  startedAt: number;
}

const live = new Map<number, LiveGame>();

export const getLive = (roomId: number): LiveGame | undefined => live.get(roomId);
export const liveGames = (): LiveGame[] => [...live.values()];
export const liveCount = (): number => live.size;

export const slotOf = (game: LiveGame, userId: number): Slot | undefined =>
  game.players.find((p) => p.userId === userId);

/** Игроки, которые ещё с нами: только они голосуют и только их ждём. */
export const activeSlots = (game: LiveGame): Slot[] => game.players.filter((p) => !p.dropped);

const nameOf = (game: LiveGame, userId: number): string =>
  game.players.find((p) => p.userId === userId)?.name ?? 'Игрок';

const adminOnly = (game: LiveGame, p: Slot, kb: InlineKeyboard): InlineKeyboard | undefined =>
  p.userId === game.adminUserId ? kb : undefined;

// ─── отрисовка сигнального сообщения ──────────────────────────────────────

interface Paint {
  text: string;
  keyboard?: InlineKeyboard;
}
type Render = (p: Slot) => Paint;

function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.description.includes('message is not modified');
}

/** Игрок больше недостижим: заблокировал бота, удалился, чат исчез. */
function isUnreachable(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    (e.error_code === 403 ||
      e.description.includes('chat not found') ||
      e.description.includes('user is deactivated'))
  );
}

function isGoneMessage(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    (e.description.includes('message to edit not found') || e.description.includes('MESSAGE_ID_INVALID'))
  );
}

function paintKey(p: Paint): string {
  return `${p.text} | ${p.keyboard ? JSON.stringify(p.keyboard.inline_keyboard) : ''}`;
}

/**
 * Правка сигнального сообщения у выбранных игроков — единственное место,
 * где важна одновременность, поэтому один Promise.all без пауз внутри.
 *
 * Повторную отправку того же текста пропускаем: Telegram ответил бы
 * «message is not modified», а вызов всё равно съел бы лимит.
 */
async function paint(api: Api, game: LiveGame, targets: readonly Slot[], render: Render): Promise<void> {
  const lost: Slot[] = [];

  await Promise.all(
    targets.map(async (p) => {
      if (p.dropped) return;
      const out = render(p);
      const key = paintKey(out);
      if (key === p.lastPaint) return;
      try {
        await api.editMessageText(p.tgId, p.signalMessageId, out.text, {
          parse_mode: 'HTML',
          reply_markup: out.keyboard,
        });
        p.lastPaint = key;
      } catch (e) {
        if (isNotModified(e)) {
          p.lastPaint = key;
          return;
        }
        if (isUnreachable(e)) {
          p.dropped = true;
          lost.push(p);
          return;
        }
        if (isGoneMessage(e)) return;
        roomLog(game.roomId, game.code).error({ err: e }, 'не смог обновить сигнальное сообщение');
      }
    }),
  );

  for (const p of lost) await releasePlayer(game, p);
}

const paintAll = (api: Api, game: LiveGame, render: Render): Promise<void> =>
  paint(api, game, game.players, render);

/**
 * Выводит недостижимого игрока из комнаты. `leaveRoom` заодно передаёт
 * админку следующему по seat — иначе комната зависла бы без кнопок.
 */
async function releasePlayer(game: LiveGame, p: Slot): Promise<void> {
  roomLog(game.roomId, game.code).warn({ tgId: p.tgId, name: p.name }, '🚪 игрок недоступен, выбывает');
  trackBotBlocked(p.userId, 'game');
  try {
    await R.leaveRoom(p.userId);
    if (game.adminUserId === p.userId) {
      const room = await R.getRoom(game.roomId);
      if (room && room.adminUserId !== p.userId) game.adminUserId = room.adminUserId;
    }
  } catch (e) {
    log.error({ err: e, roomId: game.roomId }, 'не смог вывести игрока');
  }
}

/** Можно ли продолжать партию после выпадений. Обезьянка ушла — партия не считается. */
async function ensureViable(api: Api, game: LiveGame): Promise<boolean> {
  if (game.phase === 'finished') return false;

  const alive = activeSlots(game);
  const monkeysAlive = alive.filter((p) => p.isMonkey).length;
  const monkeysTotal = game.players.filter((p) => p.isMonkey).length;

  if (monkeysAlive < monkeysTotal) {
    await abortLocked(api, game, 'Обезьянка вышла из игры — партия не засчитана.');
    return false;
  }
  if (alive.length < RULES.minPlayers) {
    await abortLocked(api, game, `Осталось меньше ${RULES.minPlayers} игроков — партия не засчитана.`);
    return false;
  }
  return true;
}

// ─── старт ────────────────────────────────────────────────────────────────

export function startGame(
  api: Api,
  room: R.Room,
  members: R.Member[],
  deckActions: string[],
  deckSlug: string,
): Promise<LiveGame | null> {
  return withRoomLock(room.id, async () => {
    if (live.has(room.id)) return null; // двойное нажатие «Начать игру»

    const d = deal(
      deckActions,
      members.map((m) => m.userId),
    );

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
    await R.touchRoom(room.id);

    // лобби больше не нужно — его место занимают карточка и сигнал
    await Promise.all(
      members.map(async (m) => {
        if (m.lobbyMessageId) await api.deleteMessage(m.user.tgId, m.lobbyMessageId).catch(() => {});
        await R.setLobbyMessage(room.id, m.userId, null);
      }),
    );

    const monkeys = new Set(d.monkeyUserIds);

    const dealt = await Promise.all(
      members.map(async (m): Promise<Slot | null> => {
        const isAdmin = m.userId === room.adminUserId;
        try {
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
            seat: m.seat,
            name: displayName(m.user),
            isMonkey: monkeys.has(m.userId),
            cardMessageId: card.message_id,
            signalMessageId: signal.message_id,
            dropped: false,
            lastPaint: '',
          };
        } catch (e) {
          if (isUnreachable(e)) {
            roomLog(room.id, room.code).warn({ tgId: m.user.tgId }, '🚪 игрок недоступен при раздаче');
            trackBotBlocked(m.userId, 'dealing');
            return null;
          }
          throw e;
        }
      }),
    );

    const players = dealt.filter((p): p is Slot => p !== null);

    const game: LiveGame = {
      gameId: row!.id,
      roomId: room.id,
      code: room.code,
      adminUserId: room.adminUserId,
      actions: d.actions,
      actionOrder: d.actionOrder,
      deckSlug,
      voteEvery: room.voteEvery,
      currentRound: 0,
      phase: 'waiting',
      players,
      ballot: 0,
      votes: new Map(),
      shortlist: null,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    };
    live.set(room.id, game);
    trackGameStarted(room.id, game.gameId, players.length, deckSlug, room.voteEvery);

    // кто-то отвалился прямо на раздаче — проверяем состав до первого раунда
    if (players.length < members.length) await ensureViable(api, game);
    return live.get(room.id) ?? null;
  });
}

// ─── раунд ────────────────────────────────────────────────────────────────

/** Пора ли голосовать: отыграли кратное число раундов или кончилась карточка. */
export function isVoteTime(game: LiveGame): boolean {
  return game.currentRound % game.voteEvery === 0 || game.currentRound >= maxRounds;
}

/**
 * Кадры отсчёта. Ощущение одновременности создаёт reveal, а не промежуточные
 * цифры, поэтому под нагрузкой отсчёт схлопываем: бюджет Telegram (~30 сообщений
 * в секунду на бота) один на все комнаты, и тратить его нужно на главный кадр.
 */
function countdownFrames(): number[] {
  if (live.size <= 4) return [3, 2, 1];
  if (live.size <= 15) return [0]; // одно «приготовились» вместо трёх цифр
  return [];
}

async function runRoundLocked(api: Api, game: LiveGame): Promise<void> {
  if (game.phase !== 'waiting' && game.phase !== 'revealed') return;
  if (game.currentRound >= maxRounds) return;
  if (!(await ensureViable(api, game))) return;

  game.phase = 'countdown';
  game.lastActivity = Date.now();
  const round = (game.currentRound += 1);
  const actionIndex = game.actionOrder[round - 1]!;

  await db.insert(rounds).values({ gameId: game.gameId, idx: round, actionIndex }).onConflictDoNothing();
  await db.update(games).set({ currentRound: round }).where(eq(games.id, game.gameId));

  const frames = countdownFrames();
  for (const left of frames) {
    await paintAll(api, game, () => ({
      text: left > 0 ? UI.renderCountdown(round, left) : UI.renderGetReady(round),
    }));
    await sleep(1000);
  }
  const rest = RULES.countdownSeconds * 1000 - frames.length * 1000;
  if (rest > 0) await sleep(rest);

  const voteTime = isVoteTime(game);
  const t0 = Date.now();
  await paintAll(api, game, (p) => ({
    text: UI.renderReveal(round, actionIndex + 1, p.isMonkey),
    keyboard: adminOnly(game, p, UI.afterRoundKeyboard(voteTime)),
  }));
  // сколько заняла доставка сигнала всей комнате — растёт, когда упираемся в лимиты Telegram
  trackRoundPlayed(game.gameId, round, actionIndex, Date.now() - t0);
  game.phase = 'revealed';
  game.lastActivity = Date.now();
}

export function runRound(api: Api, roomId: number): Promise<void> {
  return withRoomLock(roomId, async () => {
    const game = live.get(roomId);
    if (game) await runRoundLocked(api, game);
  });
}

// ─── голосование ──────────────────────────────────────────────────────────

/**
 * Счётчик «проголосовали N из M» видят только те, кто уже отдал голос.
 * Их и перерисовываем — пачкой и не чаще раза в полторы секунды.
 * Раньше на каждый голос перерисовывались все: комната на восемь человек
 * стоила 64 вызова API за один бюллетень.
 */
const counterPaint = createDebouncer(1500, 4000);

function candidatesFor(game: LiveGame, voter: Slot): UI.Candidate[] {
  const allowed = game.shortlist;
  return activeSlots(game)
    .filter((p) => p.userId !== voter.userId && (!allowed || allowed.includes(p.userId)))
    .map((p) => ({ userId: p.userId, name: p.name }));
}

function paintBallot(api: Api, game: LiveGame, targets: readonly Slot[]): Promise<void> {
  const alive = activeSlots(game);
  const total = alive.length;
  const voted = alive.filter((p) => game.votes.has(p.userId)).length;

  return paint(api, game, targets, (p) => {
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

function scheduleCounterPaint(api: Api, game: LiveGame): void {
  counterPaint.schedule(game.roomId, () =>
    withRoomLock(game.roomId, async () => {
      const g = live.get(game.roomId);
      if (!g || g.phase !== 'voting') return;
      await paintBallot(
        api,
        g,
        activeSlots(g).filter((p) => g.votes.has(p.userId)),
      );
    }),
  );
}

async function startVotingLocked(api: Api, game: LiveGame, shortlist: number[] | null): Promise<void> {
  if (game.phase === 'finished' || game.phase === 'countdown') return;
  if (!(await ensureViable(api, game))) return;

  game.phase = 'voting';
  game.ballot += 1;
  game.votes.clear();
  game.shortlist = shortlist;
  game.lastActivity = Date.now();

  await db
    .update(games)
    .set({ ballot: game.ballot, state: shortlist ? 'revote' : 'voting' })
    .where(eq(games.id, game.gameId));

  await paintBallot(api, game, activeSlots(game));
}

export function startVoting(api: Api, roomId: number, shortlist: number[] | null = null): Promise<void> {
  return withRoomLock(roomId, async () => {
    const game = live.get(roomId);
    if (game) await startVotingLocked(api, game, shortlist);
  });
}

async function castVoteLocked(api: Api, game: LiveGame, voterId: number, targetId: number): Promise<void> {
  if (game.phase !== 'voting') return;
  if (voterId === targetId) return;
  if (game.shortlist && !game.shortlist.includes(targetId)) return;

  const voter = slotOf(game, voterId);
  const target = slotOf(game, targetId);
  if (!voter || !target || voter.dropped || target.dropped) return;

  game.votes.set(voterId, targetId);
  game.lastActivity = Date.now();

  await db
    .insert(votes)
    .values({ gameId: game.gameId, ballot: game.ballot, voterId, targetId })
    .onConflictDoUpdate({
      target: [votes.gameId, votes.ballot, votes.voterId],
      set: { targetId },
    });

  // голосующему кнопки убираем сразу, остальным счётчик обновим пачкой
  await paintBallot(api, game, [voter]);
  if (!(await ensureViable(api, game))) return;

  const alive = activeSlots(game);
  if (alive.every((p) => game.votes.has(p.userId))) {
    counterPaint.cancel(game.roomId);
    await tallyLocked(api, game);
    return;
  }
  scheduleCounterPaint(api, game);
}

export function castVote(api: Api, roomId: number, voterId: number, targetId: number): Promise<void> {
  return withRoomLock(roomId, async () => {
    const game = live.get(roomId);
    if (game) await castVoteLocked(api, game, voterId, targetId);
  });
}

async function tallyLocked(api: Api, game: LiveGame): Promise<void> {
  const counts = new Map<number, number>();
  for (const target of game.votes.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
  const table = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, n]) => ({ name: nameOf(game, userId), votes: n }));

  const outcome = resolveBallot(game.votes, game.shortlist !== null);
  track({
    type: 'ballot_finished',
    roomId: game.roomId,
    gameId: game.gameId,
    payload: { ballot: game.ballot, revote: game.shortlist !== null, votes: game.votes.size, outcome: outcome.kind },
  });

  if (outcome.kind === 'revote') {
    // лидер мог выпасть между турами — тогда переголосовывать не с кем
    const leaders = outcome.leaders.filter((id) => !slotOf(game, id)?.dropped);
    if (leaders.length >= 2) {
      await startVotingLocked(api, game, leaders);
      return;
    }
    game.shortlist = null;
    game.phase = 'revealed';
    await afterFailedVote(api, game, UI.renderTie(table));
    return;
  }

  if (outcome.kind === 'tie') {
    game.shortlist = null;
    game.phase = 'revealed';
    await afterFailedVote(api, game, UI.renderTie(table));
    return;
  }

  const accused = slotOf(game, outcome.userId)!;
  const text = UI.renderVoteResult({ counts: table, accusedName: accused.name, caught: accused.isMonkey });
  game.shortlist = null;

  if (accused.isMonkey) {
    await finishLocked(api, game, true, text);
    return;
  }
  game.phase = 'revealed';
  await afterFailedVote(api, game, text);
}

/** Обезьянку не поймали: либо играем дальше, либо карточка кончилась и она победила. */
async function afterFailedVote(api: Api, game: LiveGame, resultText: string): Promise<void> {
  if (game.currentRound >= maxRounds) {
    await finishLocked(api, game, false, resultText);
    return;
  }
  await paintAll(api, game, (p) => ({
    text: `${resultText}\n\n<i>Раундов сыграно ${game.currentRound} из ${maxRounds}.</i>`,
    keyboard: adminOnly(game, p, UI.afterRoundKeyboard(false)),
  }));
}

// ─── очки и финал ─────────────────────────────────────────────────────────

interface Outcome {
  /** таблица для экрана результатов */
  scores: Array<{ name: string; points: number }>;
  points: Map<number, number>;
  ballots: Array<{ voterId: number; targetId: number }>;
}

async function computeScores(game: LiveGame, peasantsWon: boolean): Promise<Outcome> {
  const ballots = await db.select().from(votes).where(eq(votes.gameId, game.gameId));
  const points = scoreGame({ players: game.players, ballots, peasantsWon });
  const scores = game.players
    .map((p) => ({ name: p.name, points: points.get(p.userId) ?? 0 }))
    .sort((a, b) => b.points - a.points);
  return { scores, points, ballots };
}

/** Партия кончилась — возвращаем комнату в лобби, если её тем временем не закрыли. */
async function reopenLobby(roomId: number): Promise<void> {
  const room = await R.getRoom(roomId);
  if (room && room.state !== 'closed') await R.setState(roomId, 'lobby');
}

async function finishLocked(api: Api, game: LiveGame, peasantsWon: boolean, prefix = ''): Promise<void> {
  if (game.phase === 'finished') return;
  game.phase = 'finished';
  counterPaint.cancel(game.roomId);

  await db.update(games).set({ state: 'finished', endedAt: new Date() }).where(eq(games.id, game.gameId));

  const { scores, points, ballots } = await computeScores(game, peasantsWon);
  const final = UI.renderFinal({
    peasantsWon,
    monkeyNames: game.players.filter((p) => p.isMonkey).map((p) => p.name),
    scores,
    rounds: game.currentRound,
    ballots: game.ballot,
  });
  const text = prefix ? `${prefix}\n\n${final}` : final;

  await paintAll(api, game, (p) => ({
    text,
    keyboard: p.userId === game.adminUserId ? UI.againKeyboard() : UI.finalGuestKeyboard(),
  }));

  // Историю пишем после отрисовки: игроки видят результат сразу, а статистика подождёт.
  await saveGameResult({
    gameId: game.gameId,
    peasantsWon,
    players: game.players.map((p) => ({
      userId: p.userId,
      seat: p.seat,
      isMonkey: p.isMonkey,
      points: points.get(p.userId) ?? 0,
      leftEarly: p.dropped,
    })),
    ballots: ballots.map((b) => ({ voterId: b.voterId, targetId: b.targetId })),
  }).catch((e) => log.error({ err: e, gameId: game.gameId }, 'не смог записать итоги партии'));

  trackGameFinished(
    game.gameId,
    game.roomId,
    peasantsWon,
    game.currentRound,
    game.ballot,
    game.players.length,
    Math.round((Date.now() - game.startedAt) / 1000),
  );

  await R.clearGameMessages(game.roomId);
  await reopenLobby(game.roomId);
  live.delete(game.roomId);
}

export function finishGame(api: Api, roomId: number, peasantsWon: boolean, prefix = ''): Promise<void> {
  return withRoomLock(roomId, async () => {
    const game = live.get(roomId);
    if (game) await finishLocked(api, game, peasantsWon, prefix);
  });
}

async function abortLocked(api: Api, game: LiveGame, reason: string): Promise<void> {
  if (game.phase === 'finished') return;
  game.phase = 'finished';
  counterPaint.cancel(game.roomId);

  await db.update(games).set({ state: 'aborted', endedAt: new Date() }).where(eq(games.id, game.gameId));
  track({
    type: 'game_aborted',
    roomId: game.roomId,
    gameId: game.gameId,
    payload: { reason, round: game.currentRound },
  });
  await paintAll(api, game, () => ({ text: UI.renderAborted(reason) }));
  await Promise.all(game.players.map((p) => api.deleteMessage(p.tgId, p.cardMessageId).catch(() => {})));

  await R.clearGameMessages(game.roomId);
  await reopenLobby(game.roomId);
  live.delete(game.roomId);
}

export function abortGame(api: Api, roomId: number, reason: string): Promise<void> {
  return withRoomLock(roomId, async () => {
    const game = live.get(roomId);
    if (game) await abortLocked(api, game, reason);
  });
}

// ─── восстановление после перезапуска ─────────────────────────────────────

/**
 * Поднимает незавершённые партии в память. Возвращает список тех, кому
 * надо разослать «бот перезапустился» — саму рассылку делаем уже после
 * `bot.start()`, иначе полсотни партий задержат приём апдейтов на минуту.
 */
export async function recoverGames(): Promise<LiveGame[]> {
  const rows = await db.select().from(games).where(eq(games.state, 'playing'));
  const restored: LiveGame[] = [];

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
      deckSlug: '',
      voteEvery: g.voteEvery,
      currentRound: g.currentRound,
      phase: 'revealed',
      players: ready.map((m) => ({
        userId: m.userId,
        tgId: m.user.tgId,
        seat: m.seat,
        name: displayName(m.user),
        isMonkey: monkeys.has(m.userId),
        cardMessageId: m.cardMessageId!,
        signalMessageId: m.signalMessageId!,
        dropped: false,
        lastPaint: '',
      })),
      ballot: g.ballot,
      votes: new Map(),
      shortlist: null,
      lastActivity: Date.now(),
      startedAt: g.startedAt.getTime(),
    };
    live.set(g.roomId, game);
    restored.push(game);
    roomLog(g.roomId, room.code).info({ gameId: g.id, round: g.currentRound, of: maxRounds }, '♻️ партия восстановлена');
  }
  return restored;
}

/** Рассылка «бот перезапустился». Фоновая — идёт уже после старта приёма апдейтов. */
export async function announceRecovery(api: Api, restored: LiveGame[]): Promise<void> {
  for (const game of restored) {
    await withRoomLock(game.roomId, async () => {
      if (!live.has(game.roomId)) return;
      // незакрытое голосование продолжать нельзя — возвращаем к раундам
      const voteTime = game.currentRound > 0 && isVoteTime(game);
      await paintAll(api, game, (p) => ({
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
    }).catch((e) => log.error({ err: e, roomId: game.roomId }, 'не смог разослать «бот перезапустился»'));
    await sleep(200);
  }
}
