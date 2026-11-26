import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from 'grammy';
import { config } from '../config.js';
import type { User } from '../repo/users.js';
import { upsertUser } from '../repo/users.js';
import * as R from '../repo/rooms.js';
import { deckActions, getDeck, ownsDeck } from '../repo/decks.js';
import { RULES, canStart } from '../domain/rules.js';
import { bumpRoomsCreated } from '../repo/gameStats.js';
import { normalizeRoomCode, looksLikeJoinInput } from '../lib/code.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { openLobbyFor, refreshLobby, refreshLobbySoon, refreshMany, closeLobby } from '../services/lobby.js';
import {
  abortGame, castVote, getLive, runRound, skipVote, slotOf, startGame, startVoting,
} from '../services/game.js';
import { startDeckPurchase } from '../services/purchase.js';
import { roomQr } from '../services/qr.js';
import { track, trackDeckLockedHit, trackRoomCreated, trackRoomJoinFailed, trackRoomJoined } from '../services/analytics.js';
import { buildState } from './state.js';
import { verifyInitData } from './auth.js';
import { log } from '../lib/log.js';

/**
 * HTTP-API мини-аппа.
 *
 * Ручки намеренно тонкие: ни одна из них не знает правил игры. Всё, что они
 * делают, — проверяют подпись Telegram, находят пользователя и зовут ровно те
 * же функции, что и кнопки в чате. Иначе у игры оказалось бы две реализации
 * правил, и вторая (эта) неизбежно бы отстала.
 *
 * Ответ всегда один и тот же: свежий снимок состояния. Клиенту не нужно
 * гадать, что изменилось после его действия, — он получает новую картинку.
 */

/** Тело запроса у нас — пара полей. Всё, что больше, можно не читать. */
const MAX_BODY = 16 * 1024;

/** Действий в секунду на человека. Голосование и «Погнали» в этот бюджет влезают с запасом. */
const apiLimiter = createRateLimiter(60, 60_000);
/** Перебор кодов комнат — отдельный, куда более узкий лимит. */
const joinLimiter = createRateLimiter(10, 60_000);

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: Json): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(raw);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('тело запроса слишком большое');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/**
 * Кто пришёл. Единственный источник личности — подпись Telegram в initData:
 * ни заголовкам, ни телу запроса здесь верить нечему.
 */
async function authenticate(req: IncomingMessage): Promise<
  { ok: true; user: User } | { ok: false; status: number; error: string }
> {
  const header = String(req.headers['authorization'] ?? '');
  const initData = header.startsWith('tma ') ? header.slice(4) : '';

  const check = verifyInitData(initData);

  // Обычный браузер во время разработки: подписи нет и взяться ей неоткуда.
  // Лазейка живёт только при явно заданном WEBAPP_DEV_TG_ID, никогда —
  // в продакшене (см. config) и только для запроса, пришедшего на localhost.
  //
  // Последнее не педантизм: туннель для мини-аппа поднимают на той же машине,
  // где верстают, и без этой проверки публичный адрес пускал бы кого угодно
  // под чужим tg_id — проверено, ломается за полминуты.
  const dev = !check.ok && config.webapp.devTgId && isLocalRequest(req);
  if (!check.ok && !dev) {
    return {
      ok: false,
      status: 401,
      error: check.reason === 'expired' ? 'Сессия устарела — закрой и открой приложение заново.' : 'Не удалось проверить подпись Telegram.',
    };
  }

  const user = check.ok
    ? await upsertUser({
        id: check.user.id,
        username: check.user.username,
        first_name: check.user.first_name,
      })
    : await upsertUser({ id: config.webapp.devTgId!, first_name: 'Разработчик' });

  if (user.bannedUntil && user.bannedUntil > new Date()) {
    return { ok: false, status: 403, error: 'Доступ ограничен.' };
  }
  return { ok: true, user };
}

/**
 * Пришёл ли запрос прямо на localhost. Туннели (cloudflared, ssh -R) передают
 * настоящий публичный `Host`, поэтому именно он и отличает «я в браузере
 * на своей машине» от «кто-то нашёл мой временный адрес».
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const host = String(req.headers['host'] ?? '').split(':')[0]?.toLowerCase() ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Handler = (ctx: {
  api: Api;
  user: User;
  body: Json;
}) => Promise<{ error?: string; extra?: Json } | void>;

/** Комната, в которой человек сейчас состоит. */
async function myRoom(user: User): Promise<R.Room | null> {
  return (await R.activeRoomOf(user.id)) ?? null;
}

async function myAdminRoom(user: User): Promise<{ room: R.Room } | { error: string }> {
  const room = await myRoom(user);
  if (!room) return { error: 'Комната уже закрыта.' };
  if (room.adminUserId !== user.id) return { error: 'Это может только админ комнаты.' };
  return { room };
}

const ROUTES: Record<string, Handler> = {
  // ─── комната ────────────────────────────────────────────────────────────
  'POST /api/room/create': async ({ api, user }) => {
    const { room, affectedRooms } = await R.createRoom(user.id, undefined);
    trackRoomCreated(user.id, room.id, false, false);
    await bumpRoomsCreated(user.id).catch((e) => log.error({ err: e }, 'счётчик созданных комнат'));
    // Лобби в чате шлём всё равно: партия по-прежнему идёт через личку,
    // и человеку нужен тот чат открытым, а не только приложение.
    await openLobbyFor(api, room.id, user.id);
    refreshMany(api, affectedRooms);
  },

  'POST /api/room/join': async ({ api, user, body }) => {
    if (!joinLimiter.take(user.tgId)) return { error: 'Слишком много попыток. Подожди минуту.' };

    const raw = String(body['code'] ?? '');
    if (!looksLikeJoinInput(raw)) return { error: 'Это не похоже на код комнаты.' };

    const code = normalizeRoomCode(raw);
    const res = await R.joinRoom(code, user.id);
    if (!res.ok) {
      const reason: Record<R.JoinError, string> = {
        not_found: 'Комнаты с таким кодом нет.',
        closed: 'Эта комната уже закрыта.',
        in_progress: 'В этой комнате уже идёт игра.',
        full: 'В комнате уже максимум игроков.',
        locked: 'Админ закрыл вход в эту комнату.',
      };
      trackRoomJoinFailed(user.id, code, res.error);
      return { error: reason[res.error] };
    }
    if (!res.alreadyIn) trackRoomJoined(user.id, res.room.id, 'webapp');
    await R.touchRoom(res.room.id);
    await openLobbyFor(api, res.room.id, user.id);
    refreshMany(api, [res.room.id, ...res.affectedRooms]);
  },

  'POST /api/room/leave': async ({ api, user }) => {
    const room = await myRoom(user);
    if (!room) return;
    if (room.state === 'playing') return { error: 'Идёт игра — выйти нельзя.' };
    await R.leaveRoom(user.id);
    refreshLobbySoon(api, room.id);
  },

  'POST /api/room/close': async ({ api, user }) => {
    const found = await myAdminRoom(user);
    if ('error' in found) return found;
    const members = await R.listMembers(found.room.id);
    await R.closeRoom(found.room.id);
    track({ type: 'room_closed', userId: user.id, roomId: found.room.id, payload: { reason: 'webapp' } });
    await closeLobby(api, found.room, members, 'Админ закрыл комнату. /start — создать новую.');
  },

  /**
   * QR комнаты. Картинку не кладём в снимок состояния: его тянут раз в
   * секунду, а полкилобайта base64 в каждом ответе — это трафик ради того,
   * на что смотрят один раз за вечер.
   */
  'POST /api/room/qr': async ({ user }) => {
    const room = await myRoom(user);
    if (!room) return { error: 'Комната уже закрыта.' };
    const png = await roomQr(room.code);
    return { extra: { qr: `data:image/png;base64,${png.toString('base64')}` } };
  },

  'POST /api/room/deck': async ({ api, user, body }) => {
    const found = await myAdminRoom(user);
    if ('error' in found) return found;

    const deckId = num(body['deckId']);
    if (deckId === null) return { error: 'Не понял, какая колода.' };
    const deck = await getDeck(deckId);
    if (!deck) return { error: 'Колода не найдена.' };
    if (!(await ownsDeck(user.id, deck))) {
      trackDeckLockedHit(user.id, deck.slug);
      return { error: `«${deck.title}» — платная колода. Загляни в магазин.` };
    }
    await R.setDeck(found.room.id, deck.id);
    await R.touchRoom(found.room.id);
    track({ type: 'deck_selected', userId: user.id, roomId: found.room.id, payload: { deckSlug: deck.slug } });
    await refreshLobby(api, found.room.id);
  },

  'POST /api/room/voteEvery': async ({ api, user, body }) => {
    const found = await myAdminRoom(user);
    if ('error' in found) return found;

    const value = num(body['voteEvery']);
    const options = RULES.voteEveryOptions as readonly number[];
    if (value === null || !options.includes(value)) return { error: 'Такой частоты голосования нет.' };
    await R.setVoteEvery(found.room.id, value);
    await R.touchRoom(found.room.id);
    refreshLobbySoon(api, found.room.id);
  },

  'POST /api/room/lock': async ({ api, user, body }) => {
    const found = await myAdminRoom(user);
    if ('error' in found) return found;
    await R.setLocked(found.room.id, Boolean(body['locked']));
    refreshLobbySoon(api, found.room.id);
  },

  'POST /api/room/start': async ({ api, user }) => {
    const found = await myAdminRoom(user);
    if ('error' in found) return found;
    const { room } = found;
    if (room.state === 'playing') return { error: 'Игра уже идёт.' };

    const members = await R.listMembers(room.id);
    const check = canStart(members.length);
    if (!check.ok) return { error: check.reason };

    // Партия живёт в личке: карточка и сигнал — обычные сообщения бота.
    // Пустить в игру того, кому бот не может писать, — значит подвесить
    // всю комнату на человеке, который никогда не увидит номер.
    const noDm = members.filter((m) => !m.dmOk);
    if (noDm.length) return { error: 'Кто-то не открыл чат с ботом. Пусть нажмут /start.' };

    if (!room.deckId) return { error: 'Сначала выбери колоду.' };
    const deck = await getDeck(room.deckId);
    if (!deck || !(await ownsDeck(user.id, deck))) return { error: 'Эта колода недоступна.' };

    const actions = await deckActions(deck.id);
    if (actions.length < RULES.cardSize) {
      return { error: `В колоде «${deck.title}» всего ${actions.length} действий, нужно ${RULES.cardSize}.` };
    }
    const game = await startGame(api, room, members, actions, deck.slug);
    if (!game) return { error: 'Игра уже идёт.' };
  },

  // ─── партия ─────────────────────────────────────────────────────────────
  'POST /api/game/go': async ({ api, user }) => {
    const room = await myRoom(user);
    const game = room ? getLive(room.id) : undefined;
    if (!game) return { error: 'Эта игра уже закончилась.' };
    if (game.adminUserId !== user.id) return { error: 'Раунд запускает админ комнаты.' };
    if (game.phase === 'countdown') return { error: 'Отсчёт уже идёт.' };
    // Отсчёт длится три секунды — держать на нём HTTP-запрос незачем:
    // клиент увидит фазу `countdown` следующим же опросом и дорисует сам.
    void runRound(api, game.roomId).catch((e) => log.error({ err: e }, 'раунд из мини-аппа'));
  },

  'POST /api/game/voting': async ({ api, user }) => {
    const room = await myRoom(user);
    const game = room ? getLive(room.id) : undefined;
    if (!game) return { error: 'Эта игра уже закончилась.' };
    if (game.adminUserId !== user.id) return { error: 'Голосование запускает админ комнаты.' };
    if (game.phase === 'voting') return { error: 'Голосование уже идёт.' };
    if (game.ballotDone) return { error: 'В этом раунде уже голосовали — дальше следующий раунд.' };
    await startVoting(api, game.roomId);
  },

  'POST /api/game/vote': async ({ api, user, body }) => {
    const room = await myRoom(user);
    const game = room ? getLive(room.id) : undefined;
    if (!game) return { error: 'Эта игра уже закончилась.' };
    if (game.phase !== 'voting') return { error: 'Голосование уже закончилось.' };
    if (!slotOf(game, user.id)) return { error: 'Тебя нет среди игроков этой партии.' };

    const targetId = num(body['targetId']);
    if (targetId === null) return { error: 'Не понял, за кого голос.' };
    if (targetId === user.id) return { error: 'За себя голосовать нельзя.' };
    await castVote(api, game.roomId, user.id, targetId);
  },

  'POST /api/game/skip': async ({ api, user }) => {
    const room = await myRoom(user);
    const game = room ? getLive(room.id) : undefined;
    if (!game) return { error: 'Эта игра уже закончилась.' };
    if (game.phase !== 'voting') return { error: 'Голосование уже закончилось.' };
    await skipVote(api, game.roomId, user.id);
  },

  'POST /api/game/end': async ({ api, user }) => {
    const room = await myRoom(user);
    const game = room ? getLive(room.id) : undefined;
    if (!game) return { error: 'Эта игра уже закончилась.' };
    if (game.adminUserId !== user.id) return { error: 'Завершить партию может только админ.' };
    await abortGame(api, game.roomId, 'Админ завершил партию.');
  },

  // ─── магазин ────────────────────────────────────────────────────────────
  'POST /api/shop/buy': async ({ api, user, body }) => {
    const deckId = num(body['deckId']);
    if (deckId === null) return { error: 'Не понял, какая колода.' };

    const provider = String(body['provider'] ?? 'stars');
    if (provider !== 'stars' && provider !== 'wallet') return { error: 'Такого способа оплаты нет.' };

    const res = await startDeckPurchase({ userId: user.id, tgId: user.tgId, deckId, provider });
    if (!res.ok) return { error: res.message };

    // Кошелёк списывается на месте — платить некуда, товар уже выдан.
    if (res.checkout.kind === 'settled') return { extra: { paid: true } };

    if (res.checkout.kind === 'stars') {
      // Мини-апп не умеет открывать счёт, отправленный сообщением, —
      // ему нужна ссылка, которую он передаст в `openInvoice`.
      const url = await api.createInvoiceLink(
        res.checkout.title,
        res.checkout.description,
        res.checkout.payload,
        '',
        'XTR',
        [{ label: res.checkout.title, amount: res.checkout.amount }],
      );
      return { extra: { invoiceUrl: url } };
    }
    return { extra: { payUrl: res.checkout.url } };
  },
};

/**
 * Точка входа. Возвращает true, если запрос наш: иначе вызывающий отдаёт
 * его дальше — телеграмному вебхуку, статике или в 404.
 */
export async function handleApi(api: Api, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith('/api/')) return false;

  try {
    await route(api, req, res, url);
  } catch (e) {
    // Сюда падает всё, что не поймали ниже: недоступная база, оборванный
    // запрос. Без этого отказ промиса остался бы необработанным, а такой
    // в Node роняет процесс — то есть и бота вместе с мини-аппом.
    log.error({ err: e, url }, 'запрос к мини-аппу упал');
    if (!res.headersSent) send(res, 500, { ok: false, error: 'Что-то пошло не так. Попробуй ещё раз.' });
  }
  return true;
}

async function route(api: Api, req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const auth = await authenticate(req);
  if (!auth.ok) {
    send(res, auth.status, { ok: false, error: auth.error });
    return;
  }
  const { user } = auth;

  if (!apiLimiter.take(user.tgId)) {
    send(res, 429, { ok: false, error: 'Слишком часто. Подожди немного.' });
    return;
  }

  const key = `${req.method ?? 'GET'} ${url}`;

  // Состояние — единственная ручка на чтение и самая горячая: её зовут
  // раз в секунду, пока приложение открыто.
  if (key === 'GET /api/state') {
    send(res, 200, { ok: true, state: await buildState(user) });
    return;
  }

  const handler = ROUTES[key];
  if (!handler) {
    send(res, 404, { ok: false, error: 'Нет такого метода.' });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = (await handler({ api, user, body })) ?? {};
    // Свежий снимок отдаём даже с ошибкой: причина отказа часто в том,
    // что состояние успело измениться, и экран нужно обновить именно сейчас.
    const state = await buildState(user);
    send(res, 200, { ok: !out.error, error: out.error ?? null, ...(out.extra ?? {}), state });
  } catch (e) {
    log.error({ err: e, route: key, tgId: user.tgId }, 'ручка мини-аппа упала');
    send(res, 500, { ok: false, error: 'Что-то пошло не так. Попробуй ещё раз.' });
  }
}

/** Поднимать ли мини-апп вообще. Без публичного адреса он бесполезен. */
export const webAppEnabled = (): boolean => Boolean(config.webapp.url);
