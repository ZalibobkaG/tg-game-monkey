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
  'pending', 'paid', 'canceled', 'failed', 'refunded',
]);

/** Что покупают: доступ к колоде или пополнение внутреннего счёта. */
export const paymentKind = pgEnum('payment_kind', ['deck', 'topup']);

/**
 * Через что платят. `stars` — единственный способ, разрешённый Telegram для
 * цифровых товаров внутри бота; остальные заведены под внешнюю витрину
 * и физические товары и по умолчанию выключены (см. `settings`).
 */
export const paymentProvider = pgEnum('payment_provider', [
  'stars', 'yookassa', 'cryptobot', 'wallet', 'manual',
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
  /** цена в рублях — для внешних касс и витрины */
  priceRub: integer().notNull().default(0),
  /** цена в Telegram Stars: отдельный тариф, а не пересчёт из рублей */
  priceStars: integer().notNull().default(0),
  /** цена во внутренней валюте (🍌) — ей платят с личного счёта */
  priceCoins: integer().notNull().default(0),
  /** снята с продажи: купившие играют, новые не покупают */
  active: boolean().notNull().default(true),
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
  // Закрытые остаются в истории и не жгут коды — иначе «MONKEY» выгорел бы после первой игры.
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

/**
 * Заказ. Живёт от «нажал купить» до «выдали товар» и переживает перезапуск:
 * ни звёздный `successful_payment`, ни вебхук кассы не гарантируют доставку
 * ровно один раз, поэтому решение о выдаче принимается по строке в этой
 * таблице, а не по факту прихода апдейта.
 */
export const payments = pgTable('payments', {
  id: serial().primaryKey(),
  userId: integer().notNull().references(() => users.id),
  kind: paymentKind().notNull().default('deck'),
  /** null для пополнения счёта — там покупают не колоду, а 🍌 */
  deckId: integer().references(() => decks.id),
  provider: paymentProvider().notNull(),
  /**
   * Наш идентификатор заказа. Уходит провайдеру (invoice payload, metadata)
   * и возвращается обратно — по нему находим заказ, не доверяя ничему из
   * тела вебхука, кроме подписи и суммы.
   */
  orderId: text().notNull(),
  /** id платежа у провайдера — второй ключ идемпотентности */
  externalId: text(),
  /** сумма в минорных единицах: копейки для RUB, целые звёзды для XTR, 🍌 для COIN */
  amountMinor: integer().notNull(),
  currency: text().notNull().default('RUB'),
  /** сколько 🍌 зачислить, если это пополнение счёта */
  coinsAmount: integer().notNull().default(0),
  status: paymentStatus().notNull().default('pending'),
  /** ссылка на оплату у провайдера — её же показываем, если человек вернулся к заказу */
  payUrl: text(),
  /** нужен для refundStarPayment: без него звёзды не вернуть */
  telegramChargeId: text(),
  /** сырой ответ провайдера и служебные пометки — для разбора спорных платежей */
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp({ withTimezone: true }),
  refundedAt: timestamp({ withTimezone: true }),
}, (t) => [
  uniqueIndex('payments_order_uq').on(t.orderId),
  // NULL-ы в Postgres не равны друг другу, поэтому непроведённые заказы
  // с пустым external_id этот индекс не стесняет.
  uniqueIndex('payments_provider_external_uq').on(t.provider, t.externalId),
  index('payments_user_idx').on(t.userId, t.createdAt),
  index('payments_status_idx').on(t.status, t.createdAt),
]);

// ─── внутренний счёт ──────────────────────────────────────────────────────

/**
 * Личный счёт в 🍌. Отдельной таблицей, а не колонкой в `users`: строка
 * пользователя лежит в LRU-кеше и переписывается на каждый апдейт — баланс
 * там протухал бы, а инвалидация кеша на каждое начисление съела бы весь
 * смысл кеша.
 */
export const wallets = pgTable('wallets', {
  userId: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance: integer().notNull().default(0),
  /** сколько всего пришло и ушло — для витрины «заработано с рефералов» */
  totalEarned: integer().notNull().default(0),
  totalSpent: integer().notNull().default(0),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const ledgerReason = pgEnum('ledger_reason', [
  'topup', 'purchase', 'refund', 'referral_bonus', 'signup_bonus', 'admin_adjust',
]);

/**
 * Журнал движений по счёту. Баланс в `wallets` — материализованный итог,
 * а правда лежит здесь: по журналу баланс можно пересчитать и сверить.
 * `balanceAfter` пишем в той же транзакции — иначе спор «куда делись 🍌»
 * разбирать нечем.
 */
export const walletLedger = pgTable('wallet_ledger', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** со знаком: списание отрицательное */
  delta: integer().notNull(),
  balanceAfter: integer().notNull(),
  reason: ledgerReason().notNull(),
  /** платёж, реферал или админ, вызвавший движение */
  refId: integer(),
  comment: text().notNull().default(''),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('wallet_ledger_user_idx').on(t.userId, t.createdAt)]);

// ─── реферальная программа ────────────────────────────────────────────────

/**
 * Кто кого привёл. Одна строка на приглашённого: `inviteeId` — первичный
 * ключ, поэтому переприсвоить себе чужого реферала нельзя, кто успел —
 * тот и пригласил.
 *
 * Начисления живут отдельно (`wallet_ledger`): правила программы ещё не
 * утверждены, а связь «кто кого привёл» уже нужна — её нельзя восстановить
 * задним числом.
 */
export const referrals = pgTable('referrals', {
  inviteeId: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  referrerId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** как пришёл: deeplink | manual */
  source: text().notNull().default('deeplink'),
  /** приветственный бонус приглашённому уже выдан */
  signupRewarded: boolean().notNull().default(false),
  /** сколько 🍌 суммарно принёс этот реферал пригласившему */
  earned: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('referrals_referrer_idx').on(t.referrerId)]);

/**
 * Личный код-приглашение. Отдельно от id, чтобы ссылка не выдавала
 * порядковый номер пользователя и не подбиралась перебором.
 */
export const referralCodes = pgTable('referral_codes', {
  userId: integer().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('referral_codes_code_uq').on(t.code)]);

// ─── настройки, редактируемые из панели ───────────────────────────────────

/**
 * Значения, которые меняются без выкатки: включённые способы оплаты,
 * размеры реферальных бонусов, курс пополнения. В окружении держать нельзя —
 * их правит владелец из панели, а не тот, у кого есть доступ к серверу.
 */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  updatedBy: integer().references(() => users.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

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

/** Кто и с какой ролью играл. Без этой таблицы история партий неполная: роли лежали в jsonb и терялись. */
export const gamePlayers = pgTable('game_players', {
  gameId: integer().notNull().references(() => games.id, { onDelete: 'cascade' }),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  seat: integer().notNull(),
  isMonkey: boolean().notNull(),
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
