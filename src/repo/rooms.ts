import { and, asc, desc, eq, max, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { roomMembers, rooms, users } from '../db/schema.js';
import { generateRoomCode } from '../lib/code.js';
import { RULES } from '../domain/rules.js';
import { getDeckBySlug } from './decks.js';

export type Room = typeof rooms.$inferSelect;
export type Member = typeof roomMembers.$inferSelect & {
  user: typeof users.$inferSelect;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getRoom(id: number): Promise<Room | undefined> {
  return db.query.rooms.findFirst({ where: eq(rooms.id, id) });
}

export async function getRoomByCode(code: string): Promise<Room | undefined> {
  return db.query.rooms.findFirst({ where: eq(rooms.code, code) });
}

/** Активная комната игрока — он может быть только в одной. */
export async function activeRoomOf(userId: number): Promise<Room | undefined> {
  const [row] = await db
    .select({ room: rooms })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(and(eq(roomMembers.userId, userId), eq(roomMembers.isActive, true), ne(rooms.state, 'closed')))
    .orderBy(desc(rooms.id))
    .limit(1);
  return row?.room;
}

export async function listMembers(roomId: number): Promise<Member[]> {
  const rows = await db
    .select({ m: roomMembers, u: users })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.isActive, true)))
    .orderBy(asc(roomMembers.seat));
  return rows.map((r) => ({ ...r.m, user: r.u }));
}

/**
 * Выводит игрока из всех активных комнат.
 * Если он был админом — права уходят следующему по seat, иначе комната закрывается.
 * Возвращает id затронутых комнат, чтобы обновить их лобби.
 */
async function leaveAll(tx: Tx, userId: number): Promise<number[]> {
  const affected = await tx
    .select({ roomId: roomMembers.roomId, adminUserId: rooms.adminUserId })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(and(eq(roomMembers.userId, userId), eq(roomMembers.isActive, true), ne(rooms.state, 'closed')));

  for (const { roomId, adminUserId } of affected) {
    await tx
      .update(roomMembers)
      .set({ isActive: false, lobbyMessageId: null })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));

    if (adminUserId === userId) {
      const [next] = await tx
        .select({ userId: roomMembers.userId })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.isActive, true)))
        .orderBy(asc(roomMembers.seat))
        .limit(1);
      if (next) {
        await tx.update(rooms).set({ adminUserId: next.userId }).where(eq(rooms.id, roomId));
      } else {
        await tx.update(rooms).set({ state: 'closed', closedAt: new Date() }).where(eq(rooms.id, roomId));
      }
    }
  }
  return affected.map((a) => a.roomId);
}

export async function createRoom(
  adminUserId: number,
  chatId?: number,
): Promise<{ room: Room; affectedRooms: number[] }> {
  const base = await getDeckBySlug('base');

  return db.transaction(async (tx) => {
    const affectedRooms = await leaveAll(tx, adminUserId);

    let room: Room | undefined;
    for (let attempt = 0; attempt < 8 && !room; attempt++) {
      const [created] = await tx
        .insert(rooms)
        .values({
          code: generateRoomCode(),
          adminUserId,
          chatId: chatId ?? null,
          deckId: base?.id ?? null,
          voteEvery: RULES.defaultVoteEvery,
        })
        .onConflictDoNothing({ target: rooms.code })
        .returning();
      room = created;
    }
    if (!room) throw new Error('Не удалось выделить код комнаты');

    await tx.insert(roomMembers).values({ roomId: room.id, userId: adminUserId, seat: 1 });
    return { room, affectedRooms: affectedRooms.filter((id) => id !== room!.id) };
  });
}

export type JoinResult =
  | { ok: true; room: Room; alreadyIn: boolean; affectedRooms: number[] }
  | { ok: false; error: 'not_found' | 'closed' | 'in_progress' | 'full' };

export async function joinRoom(code: string, userId: number): Promise<JoinResult> {
  const room = await getRoomByCode(code);
  if (!room) return { ok: false, error: 'not_found' };
  if (room.state === 'closed') return { ok: false, error: 'closed' };

  const existing = await db.query.roomMembers.findFirst({
    where: and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)),
  });
  if (existing?.isActive) return { ok: true, room, alreadyIn: true, affectedRooms: [] };

  if (room.state === 'playing') return { ok: false, error: 'in_progress' };

  const members = await listMembers(room.id);
  if (members.length >= RULES.maxPlayers) return { ok: false, error: 'full' };

  const affectedRooms = await db.transaction(async (tx) => {
    const affected = await leaveAll(tx, userId);
    const [{ value: topSeat } = { value: null }] = await tx
      .select({ value: max(roomMembers.seat) })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, room.id));
    const seat = (topSeat ?? 0) + 1;

    await tx
      .insert(roomMembers)
      .values({ roomId: room.id, userId, seat })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: { isActive: true, seat, dmOk: true },
      });
    return affected.filter((id) => id !== room.id);
  });

  return { ok: true, room, alreadyIn: false, affectedRooms };
}

/** Игрок может быть только в одной комнате, поэтому id комнаты не нужен. */
export async function leaveRoom(userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await leaveAll(tx, userId);
  });
}

export async function closeRoom(roomId: number): Promise<void> {
  await db.update(rooms).set({ state: 'closed', closedAt: new Date() }).where(eq(rooms.id, roomId));
  await db.update(roomMembers).set({ isActive: false, lobbyMessageId: null }).where(eq(roomMembers.roomId, roomId));
}

export async function setDeck(roomId: number, deckId: number): Promise<void> {
  await db.update(rooms).set({ deckId }).where(eq(rooms.id, roomId));
}

export async function setVoteEvery(roomId: number, voteEvery: number): Promise<void> {
  await db.update(rooms).set({ voteEvery }).where(eq(rooms.id, roomId));
}

export async function setState(roomId: number, state: Room['state']): Promise<void> {
  await db.update(rooms).set({ state }).where(eq(rooms.id, roomId));
}

export async function setLobbyMessage(roomId: number, userId: number, messageId: number | null): Promise<void> {
  await db
    .update(roomMembers)
    .set({ lobbyMessageId: messageId })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}

export async function setDmOk(roomId: number, userId: number, dmOk: boolean): Promise<void> {
  await db
    .update(roomMembers)
    .set({ dmOk })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}

export async function setGroupMessage(roomId: number, chatId: number, messageId: number): Promise<void> {
  await db.update(rooms).set({ chatId, groupMessageId: messageId }).where(eq(rooms.id, roomId));
}

export async function setGameMessages(
  roomId: number,
  userId: number,
  cardMessageId: number,
  signalMessageId: number,
): Promise<void> {
  await db
    .update(roomMembers)
    .set({ cardMessageId, signalMessageId })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}

export async function clearGameMessages(roomId: number): Promise<void> {
  await db
    .update(roomMembers)
    .set({ cardMessageId: null, signalMessageId: null })
    .where(eq(roomMembers.roomId, roomId));
}
