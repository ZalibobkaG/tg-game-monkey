import {
  pgTable, pgEnum, serial, bigint, text, boolean, integer,
  timestamp, jsonb, uniqueIndex, index, primaryKey,
} from 'drizzle-orm/pg-core';

export const roomState = pgEnum('room_state', [
  'lobby', 'playing', 'closed',
]);

export const gameState = pgEnum('game_state', [
  'dealing', 'playing', 'voting', 'revote', 'finished', 'aborted',
]);

export const paymentStatus = pgEnum('payment_status', [
  'pending', 'paid', 'failed', 'refunded',
]);

export const users = pgTable('users', {
  id: serial().primaryKey(),
  tgId: bigint({ mode: 'number' }).notNull(),
  username: text(),
  firstName: text().notNull().default(''),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('users_tg_id_uq').on(t.tgId)]);

export const decks = pgTable('decks', {
  id: serial().primaryKey(),
  slug: text().notNull(),
  title: text().notNull(),
  description: text().notNull().default(''),
  isPremium: boolean().notNull().default(false),
  priceRub: integer().notNull().default(0),
  sort: integer().notNull().default(0),
}, (t) => [uniqueIndex('decks_slug_uq').on(t.slug)]);

export const deckItems = pgTable('deck_items', {
  id: serial().primaryKey(),
  deckId: integer().notNull().references(() => decks.id, { onDelete: 'cascade' }),
  text: text().notNull(),
}, (t) => [index('deck_items_deck_idx').on(t.deckId)]);

/** Права на колоду. Базовая колода прав не требует. */
export const userDecks = pgTable('user_decks', {
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  deckId: integer().notNull().references(() => decks.id, { onDelete: 'cascade' }),
  paymentId: integer(),
  acquiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.deckId] })]);

export const rooms = pgTable('rooms', {
  id: serial().primaryKey(),
  code: text().notNull(),
  adminUserId: integer().notNull().references(() => users.id),
  /** id группового чата, если комната анонсирована в группе */
  chatId: bigint({ mode: 'number' }),
  groupMessageId: integer(),
  state: roomState().notNull().default('lobby'),
  deckId: integer().references(() => decks.id),
  roundsCount: integer().notNull().default(5),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex('rooms_code_uq').on(t.code)]);

export const roomMembers = pgTable('room_members', {
  roomId: integer().notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  seat: integer().notNull(),
  isActive: boolean().notNull().default(true),
  /** удаётся ли писать игроку в ЛС */
  dmOk: boolean().notNull().default(true),
  /** сообщение-лобби в ЛС игрока, которое мы редактируем */
  lobbyMessageId: integer(),
  /** карточка игрока: прячется и раскрывается по кнопке */
  cardMessageId: integer(),
  /** сообщение сигнала: отсчёт и номер действия */
  signalMessageId: integer(),
  joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.roomId, t.userId] }),
  index('room_members_user_idx').on(t.userId),
]);

export const games = pgTable('games', {
  id: serial().primaryKey(),
  roomId: integer().notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  deckId: integer().notNull().references(() => decks.id),
  /** снапшот 10 действий на момент старта */
  actions: jsonb().$type<string[]>().notNull(),
  monkeyUserIds: jsonb().$type<number[]>().notNull(),
  state: gameState().notNull().default('dealing'),
  roundsCount: integer().notNull(),
  /** какие действия и в каком порядке разыгрываем — индексы в actions */
  actionOrder: jsonb().$type<number[]>().notNull(),
  /** 0 — ещё не начали, дальше 1..roundsCount */
  currentRound: integer().notNull().default(0),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp({ withTimezone: true }),
}, (t) => [index('games_room_idx').on(t.roomId)]);

export const rounds = pgTable('rounds', {
  id: serial().primaryKey(),
  gameId: integer().notNull().references(() => games.id, { onDelete: 'cascade' }),
  idx: integer().notNull(),
  /** индекс действия в games.actions (0..9) */
  actionIndex: integer().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('rounds_game_idx_uq').on(t.gameId, t.idx)]);

export const votes = pgTable('votes', {
  id: serial().primaryKey(),
  gameId: integer().notNull().references(() => games.id, { onDelete: 'cascade' }),
  /** 1 — основное голосование, 2+ — переголосование */
  ballot: integer().notNull().default(1),
  voterId: integer().notNull().references(() => users.id),
  targetId: integer().notNull().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('votes_ballot_voter_uq').on(t.gameId, t.ballot, t.voterId)]);

export const payments = pgTable('payments', {
  id: serial().primaryKey(),
  userId: integer().notNull().references(() => users.id),
  deckId: integer().notNull().references(() => decks.id),
  provider: text().notNull(),
  /** id платежа у провайдера — ключ идемпотентности */
  externalId: text(),
  amountMinor: integer().notNull(),
  currency: text().notNull().default('RUB'),
  status: paymentStatus().notNull().default('pending'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('payments_provider_external_uq').on(t.provider, t.externalId)]);
