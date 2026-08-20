import { db } from '../db/index.js';
import { events } from '../db/schema.js';
import { log } from '../lib/log.js';

/**
 * Аналитика. Запись события никогда не должна стоять на пути игрового
 * цикла (в частности — синхронного «сигнала» с правкой сообщений всем
 * игрокам), поэтому track() синхронна и ничего не ждёт: события копятся
 * в буфере, а в базу уходят пачкой по таймеру или при переполнении.
 */

export type EventType =
  | 'user_start'
  | 'room_created'
  | 'room_joined'
  | 'room_join_failed'
  | 'room_code_changed'
  | 'room_closed'
  | 'game_started'
  | 'round_played'
  | 'ballot_finished'
  | 'game_finished'
  | 'game_aborted'
  | 'deck_selected'
  | 'deck_locked_hit'
  | 'feedback_sent'
  | 'feedback_reply_started'
  | 'feedback_replied'
  | 'admin_action'
  | 'bot_blocked';

export interface TrackedEvent {
  type: EventType;
  userId?: number | null;
  roomId?: number | null;
  gameId?: number | null;
  payload?: Record<string, unknown>;
}

/** Строка на вставку — форма, которую ожидает drizzle для events. */
type EventRow = typeof events.$inferInsert;

const MAX_BUFFER = 200;
const FLUSH_MS = 2000;
/** Потолок буфера при недоступной базе — иначе память течёт бесконечно. */
const OVERFLOW_CAP = MAX_BUFFER * 5;

const buf: EventRow[] = [];
let flushing = false;

/** Кладёт событие в буфер. Синхронна, ничего не ждёт и никогда не бросает. */
export function track(event: TrackedEvent): void {
  try {
    buf.push({
      type: event.type,
      userId: event.userId ?? null,
      roomId: event.roomId ?? null,
      gameId: event.gameId ?? null,
      payload: event.payload ?? {},
    });
  } catch (e) {
    log.error({ err: e }, 'аналитика: вставка не прошла');
    return;
  }
  if (buf.length >= MAX_BUFFER) void flush();
}

/**
 * Сбрасывает буфер в базу одним insert'ом. Параллельные вызовы не
 * дублируют вставку — второй вызов, застав flushing === true, просто
 * выходит: события, накопившиеся за время текущей вставки, заберёт
 * тот же цикл (while ниже), не отдельный запуск.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  if (buf.length === 0) return;

  flushing = true;
  try {
    let batch = buf.splice(0);
    while (batch.length > 0) {
      try {
        await db.insert(events).values(batch);
      } catch (e) {
        log.error({ err: e }, 'аналитика: вставка не прошла');
        buf.unshift(...batch);
        const overflow = buf.length - OVERFLOW_CAP;
        if (overflow > 0) {
          buf.splice(0, overflow);
          log.warn({ dropped: overflow }, 'аналитика: буфер переполнен, старые события отброшены');
        }
        break;
      }
      batch = buf.splice(0);
    }
  } finally {
    flushing = false;
  }
}

/** Текущий размер буфера — для health-эндпоинта админ-панели. */
export function bufferSize(): number {
  return buf.length;
}

// Периодический сброс. unref() — таймер не должен держать процесс живым.
setInterval(() => { void flush(); }, FLUSH_MS).unref();

// ─── типизированные хелперы ────────────────────────────────────────────

export const trackUserStart = (userId: number, source: string) =>
  track({ type: 'user_start', userId, payload: { source } });

export const trackRoomCreated = (userId: number, roomId: number, fromGroup: boolean, customCode: boolean) =>
  track({ type: 'room_created', userId, roomId, payload: { fromGroup, customCode } });

export const trackRoomJoined = (userId: number, roomId: number, via: string) =>
  track({ type: 'room_joined', userId, roomId, payload: { via } });

export const trackRoomJoinFailed = (userId: number, code: string, reason: string) =>
  track({ type: 'room_join_failed', userId, payload: { code, reason } });

export const trackGameStarted = (roomId: number, gameId: number, players: number, deckSlug: string, voteEvery: number) =>
  track({ type: 'game_started', roomId, gameId, payload: { players, deckSlug, voteEvery } });

export const trackRoundPlayed = (gameId: number, round: number, actionIndex: number, dispersionMs: number) =>
  track({ type: 'round_played', gameId, payload: { round, actionIndex, dispersionMs } });

export const trackGameFinished = (
  gameId: number,
  roomId: number,
  peasantsWon: boolean,
  rounds: number,
  ballots: number,
  players: number,
  durationSec: number,
) =>
  track({ type: 'game_finished', gameId, roomId, payload: { peasantsWon, rounds, ballots, players, durationSec } });

export const trackDeckLockedHit = (userId: number, deckSlug: string) =>
  track({ type: 'deck_locked_hit', userId, payload: { deckSlug } });

/**
 * Привилегированное действие из панели. Бан, выдача колоды, закрытие чужой
 * комнаты — всё, что один человек делает с данными другого, должно оставлять след.
 */
export const trackAdminAction = (
  adminUserId: number,
  action: string,
  targetUserId?: number | null,
  details?: Record<string, unknown>,
) => track({ type: 'admin_action', userId: adminUserId, payload: { action, targetUserId: targetUserId ?? null, ...details } });

export const trackBotBlocked = (userId: number, where: string) =>
  track({ type: 'bot_blocked', userId, payload: { where } });
