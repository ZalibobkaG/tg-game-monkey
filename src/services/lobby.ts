import { Api, GrammyError } from 'grammy';
import * as R from '../repo/rooms.js';
import { getDeck } from '../repo/decks.js';
import { renderGroupLobby, renderLobby } from '../ui/lobby.js';
import { createDebouncer } from '../lib/debounce.js';
import { trackBotBlocked } from './analytics.js';

/**
 * Схлопывание перерисовок лобби. Когда компания из десяти человек сканирует
 * QR одновременно, немедленная перерисовка стоит сто правок, из которых
 * полезны последние десять.
 */
const lobbyPaint = createDebouncer(400, 1500);

function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.description.includes('message is not modified');
}
function isGone(e: unknown): boolean {
  return (
    e instanceof GrammyError &&
    (e.description.includes('message to edit not found') ||
      e.description.includes("message can't be edited") ||
      e.description.includes('MESSAGE_ID_INVALID'))
  );
}
export function isBlocked(e: unknown): boolean {
  return e instanceof GrammyError && (e.error_code === 403 || e.description.includes('chat not found'));
}

/** Отправляет игроку лобби и запоминает message_id для последующих правок. */
async function sendLobbyTo(api: Api, room: R.Room, members: R.Member[], member: R.Member): Promise<void> {
  const deck = room.deckId ? await getDeck(room.deckId) : undefined;
  const { text, keyboard } = renderLobby({ room, members, deck, viewerUserId: member.userId });
  try {
    const msg = await api.sendMessage(member.user.tgId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    await R.setLobbyMessage(room.id, member.userId, msg.message_id);
    if (!member.dmOk) await R.setDmOk(room.id, member.userId, true);
  } catch (e) {
    if (isBlocked(e)) {
      await R.setDmOk(room.id, member.userId, false);
      trackBotBlocked(member.userId, 'lobby');
      return;
    }
    throw e;
  }
}

/** Перерисовывает лобби у всех участников и в групповом чате. */
export async function refreshLobby(api: Api, roomId: number): Promise<void> {
  const room = await R.getRoom(roomId);
  if (!room || room.state === 'closed') return;

  const members = await R.listMembers(roomId);
  const deck = room.deckId ? await getDeck(room.deckId) : undefined;

  await Promise.all(
    members.map(async (m) => {
      if (!m.lobbyMessageId) {
        await sendLobbyTo(api, room, members, m);
        return;
      }
      const { text, keyboard } = renderLobby({ room, members, deck, viewerUserId: m.userId });
      try {
        await api.editMessageText(m.user.tgId, m.lobbyMessageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (e) {
        if (isNotModified(e)) return;
        if (isGone(e)) return sendLobbyTo(api, room, members, m);
        if (isBlocked(e)) {
          await R.setDmOk(room.id, m.userId, false);
          return;
        }
        throw e;
      }
    }),
  );

  if (room.chatId && room.groupMessageId) {
    const { text, keyboard } = renderGroupLobby({ room, members, deck });
    try {
      await api.editMessageText(room.chatId, room.groupMessageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      if (!isNotModified(e) && !isGone(e) && !isBlocked(e)) throw e;
    }
  }
}

/** Отложенная перерисовка — версия по умолчанию для join/leave и смены настроек. */
export function refreshLobbySoon(api: Api, roomId: number): void {
  lobbyPaint.schedule(roomId, () => refreshLobby(api, roomId));
}

export function refreshMany(api: Api, roomIds: number[]): void {
  for (const id of new Set(roomIds)) refreshLobbySoon(api, id);
}

/** Первый показ лобби игроку сразу после входа: старое сообщение убираем, новое шлём вниз чата. */
export async function openLobbyFor(api: Api, roomId: number, userId: number): Promise<void> {
  const room = await R.getRoom(roomId);
  if (!room) return;
  const members = await R.listMembers(roomId);
  const me = members.find((m) => m.userId === userId);
  if (!me) return;
  if (me.lobbyMessageId) {
    await api.deleteMessage(me.user.tgId, me.lobbyMessageId).catch(() => {});
  }
  await sendLobbyTo(api, room, members, me);
}

/** Закрывает лобби у всех: снимает кнопки и пишет, что комната закрыта. */
export async function closeLobby(api: Api, room: R.Room, members: R.Member[], reason: string): Promise<void> {
  lobbyPaint.cancel(room.id);
  await Promise.all(
    members.map(async (m) => {
      if (!m.lobbyMessageId) return;
      await api
        .editMessageText(m.user.tgId, m.lobbyMessageId, `🐒 Комната <code>${room.code}</code>\n\n${reason}`, {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    }),
  );
  if (room.chatId && room.groupMessageId) {
    await api
      .editMessageText(room.chatId, room.groupMessageId, `🐒 Комната <code>${room.code}</code>\n\n${reason}`, {
        parse_mode: 'HTML',
      })
      .catch(() => {});
  }
}

/** Публикует анонс комнаты в групповом чате. */
export async function announceInGroup(api: Api, roomId: number, chatId: number): Promise<void> {
  const room = await R.getRoom(roomId);
  if (!room) return;
  const members = await R.listMembers(roomId);
  const deck = room.deckId ? await getDeck(room.deckId) : undefined;
  const { text, keyboard } = renderGroupLobby({ room, members, deck });
  const msg = await api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  await R.setGroupMessage(roomId, chatId, msg.message_id);
}
