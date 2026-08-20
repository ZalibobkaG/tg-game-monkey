import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, serial, bigserial, bigint, text, boolean, integer,
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
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** заблокировал бота — в рассылки не попадает */
  blockedBot: boolean().notNull().default(false),
  /** откуда пришёл: direct | deeplink_room | deeplink_group */
  source: text().notNull().default('direct'),
  marketingOptOut: boolean().notNull().default(false),
  bannedUntil: timestamp({ withTimezone: true }),
}, (t) => [
  uniqueIndex('users_tg_id_uq').on(t.tgId),
  index('users_last_seen_idx').on(t.lastSeenAt),
]);

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
  /** код задан админом вручную, а не сгенерирован */
  codeCustom: boolean().notNull().default(false),
  /** админ запер комнату — новые игроки не входят */
  locked: boolean().notNull().default(false),
  adminUserId: integer().notNull().references(() => users.id),
  /** id группового чата, если комната анонсирована в группе */
  chatId: bigint({ mode: 'number' }),
  groupMessageId: integer(),
  state: roomState().notNull().default('lobby'),
  deckId: integer().references(() => decks.id),
  /** через сколько раундов запускать голосование */
  voteEvery: integer().notNull().default(1),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** последнее действие в комнате — по нему janitor закрывает брошенные */
  lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp({ withTimezone: true }),
}, (t) => [
  // Частичный уникальный индекс: код занят только живой комнатой.
  // Закрытые остаются в истории и не жгут коды — иначе «LITVIN» выгорел бы после первой игры.
  uniqueIndex('rooms_code_active_uq').on(t.code).where(sql`state <> 'closed'`),
  index('rooms_code_idx').on(t.code),
]);

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
  voteEvery: integer().notNull(),
  /** номер текущего голосования; растёт и при переголосовании */
  ballot: integer().notNull().default(0),
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

// ─── статистика ───────────────────────────────────────────────────────────

/**
 * Сырой лог событий. Без внешних ключей намеренно: лог должен пережить
 * удаление комнаты, а вставка — не брать лишних локов. Пишется пачками
 * из буфера в памяти, чтобы аналитика никогда не стояла на пути отсчёта.
 */
export const events = pgTable('events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  type: text().notNull(),
  userId: integer(),
  roomId: integer(),
  gameId: integer(),
  payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('events_type_time_idx').on(t.type, t.createdAt),
  index('events_user_time_idx').on(t.userId, t.createdAt),
]);

/** Кто и с какой ролью играл. Без этой таблицы история партий неполная: роли лежали в jsonb, а очки не сохранялись вовсе. */
export const gamePlayers = pgTable('game_players', {
  gameId: integer().notNull().references(() => games.id, { onDelete: 'cascade' }),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  seat: integer().notNull(),
  isMonkey: boolean().notNull(),
  points: integer().notNull().default(0),
  /** вышел или заблокировал бота посреди партии */
  leftEarly: boolean().notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.gameId, t.userId] }),
  index('game_players_user_idx').on(t.userId),
]);

/** Агрегаты игрока. Обновляются инкрементально (x = x + excluded.x), не пересчётом. */
export const userStats = pgTable('user_stats', {
  userId: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  gamesPlayed: integer().notNull().default(0),
  gamesAsMonkey: integer().notNull().default(0),
  winsAsMonkey: integer().notNull().default(0),
  winsAsPeasant: integer().notNull().default(0),
  votesCast: integer().notNull().default(0),
  correctVotes: integer().notNull().default(0),
  timesAccused: integer().notNull().default(0),
  pointsTotal: integer().notNull().default(0),
  roomsCreated: integer().notNull().default(0),
  lastGameAt: timestamp({ withTimezone: true }),
});

// ─── обратная связь и админы ──────────────────────────────────────────────

export const feedbackKind = pgEnum('feedback_kind', ['idea', 'bug', 'deck', 'other']);
export const feedbackStatus = pgEnum('feedback_status', ['new', 'read', 'answered', 'archived', 'spam']);

export const feedback = pgTable('feedback', {
  id: serial().primaryKey(),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** комната, из которой написали — админу сразу виден контекст */
  roomId: integer(),
  kind: feedbackKind().notNull().default('other'),
  text: text().notNull(),
  status: feedbackStatus().notNull().default('new'),
  answeredBy: integer().references(() => users.id),
  reply: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp({ withTimezone: true }),
}, (t) => [
  index('feedback_status_idx').on(t.status, t.createdAt),
  index('feedback_user_idx').on(t.userId),
]);

export const adminRole = pgEnum('admin_role', ['owner', 'moderator', 'support']);

/** ADMIN_IDS из окружения — бутстрап-владельцы; остальные живут здесь и назначаются из панели. */
export const admins = pgTable('admins', {
  userId: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  role: adminRole().notNull().default('support'),
  addedBy: integer().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
