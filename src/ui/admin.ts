import { InlineKeyboard } from 'grammy';
import type { DeckUsage, EventRow, PeriodStats, SignalHealth, UserCard } from '../repo/stats.js';
import type { Deck } from '../repo/decks.js';
import type { OpenRoom } from '../repo/rooms.js';
import type { AdminRole, AdminRow } from '../repo/admins.js';
import type { User } from '../repo/users.js';
import { displayName } from '../repo/users.js';
import { RULES } from '../domain/rules.js';
import { ITEM_MAX_LEN, ITEM_MIN_LEN, MAX_ITEMS } from '../domain/deckInput.js';
import type { DeckEditMode } from '../domain/deckInput.js';
import { COIN, coins, rubles } from '../domain/economy.js';
import type { Economy } from '../domain/economy.js';
import type { PaymentRow, Revenue } from '../repo/payments.js';
import type { TopReferrer } from '../repo/referrals.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Русское склонение по числу: 1 победа, 2 победы, 5 побед. */
function plural(n: number, one: string, few: string, many: string): string {
  if (n % 100 >= 11 && n % 100 <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function who(u: Pick<User, 'firstName' | 'username'>): string {
  const name = esc(displayName(u));
  return u.username ? `${name} (@${esc(u.username)})` : name;
}

// ─── главный экран ────────────────────────────────────────────────────────

export function renderHome(args: {
  role: AdminRole;
  newFeedback: number;
  liveGames: number;
  openRooms: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { role, newFeedback, liveGames, openRooms } = args;

  const text = [
    '🔧 <b>Админ-панель</b>',
    '',
    `Роль: <b>${role}</b>`,
    `🎮 Живых партий: <b>${liveGames}</b> · открытых комнат: <b>${openRooms}</b>`,
    `💬 Новых обращений: <b>${newFeedback}</b>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('📊 Статистика', 'adm:stats:7')
    .text(newFeedback ? `💬 Обращения (${newFeedback})` : '💬 Обращения', 'adm:fb')
    .row()
    .text('👤 Пользователи', 'adm:users')
    .text('🎮 Комнаты', 'adm:rooms')
    .row()
    .text('🏆 Лидеры', 'adm:top')
    .text('🎴 Колоды', 'adm:decks')
    .row()
    .text('💰 Оплата', 'adm:pay:7')
    .row()
    .text('📜 Журнал', 'adm:log:admin')
    .text('⚙️ Система', 'adm:sys');

  return { text, keyboard };
}

// ─── статистика ───────────────────────────────────────────────────────────

export function renderStats(args: {
  days: number;
  stats: PeriodStats;
  decks: DeckUsage[];
  signal: SignalHealth;
}): { text: string; keyboard: InlineKeyboard } {
  const { days, stats: s, decks, signal } = args;
  const label = days === 1 ? 'за сегодня' : `за ${days} дней`;

  const completion = s.gamesStarted ? s.gamesFinished / s.gamesStarted : 0;

  const deckLines = decks.length
    ? decks.map((d) => {
        const locked = d.lockedHits ? ` · 🔒 тыкнули ${d.lockedHits}` : '';
        return `• ${esc(d.title)} — ${d.games}${locked}`;
      })
    : ['• пока пусто'];

  const text = [
    `📊 <b>Статистика ${label}</b>`,
    '',
    `👤 Новых: <b>${s.newUsers}</b> · активных: <b>${s.activeUsers}</b>`,
    `🚪 Комнат создано: <b>${s.roomsCreated}</b>`,
    `🎮 Партий начато: <b>${s.gamesStarted}</b>, доиграно: <b>${s.gamesFinished}</b>, брошено: <b>${s.gamesAborted}</b>`,
    `✅ Доигрывают: <b>${pct(completion)}</b>`,
    '',
    '<b>Здоровье игры</b>',
    `🐒 Winrate обезьянки: <b>${pct(s.monkeyWinRate)}</b>`,
    '<i>норма 40–50%. Выше — карточки слишком похожи, ниже — обезьянку палят сразу</i>',
    `👥 Средний размер комнаты: <b>${num(s.avgPlayers)}</b> · раундов: <b>${num(s.avgRounds)}</b>`,
    signal.samples
      ? `⚡ Разброс сигнала: медиана <b>${signal.medianMs} мс</b>, p95 <b>${signal.p95Ms} мс</b> (${signal.samples} раундов)`
      : '⚡ Разброс сигнала: данных пока нет',
    '',
    '<b>Колоды</b>',
    ...deckLines,
    '',
    `💬 Обращений: <b>${s.feedbackCount}</b>`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text(days === 1 ? '· Сегодня ·' : 'Сегодня', 'adm:stats:1')
    .text(days === 7 ? '· 7 дней ·' : '7 дней', 'adm:stats:7')
    .text(days === 30 ? '· 30 дней ·' : '30 дней', 'adm:stats:30')
    .row()
    .text('← Назад', 'adm:home');

  return { text, keyboard };
}

// ─── пользователи ─────────────────────────────────────────────────────────

/** Заголовок вынесен в константу: по нему узнаём приглашение в `reply_to_message`. */
const SEARCH_HEAD = '👤 <b>Поиск пользователя</b>';
export const SEARCH_PROMPT_RE = /^👤 Поиск пользователя/;

export function renderSearchPrompt(): string {
  return [
    SEARCH_HEAD,
    '',
    'Пришли <code>@username</code>, tg_id или имя ответом на это сообщение.',
    '/cancel — отменить.',
  ].join('\n');
}

export function renderSearchResults(users: User[]): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  if (!users.length) {
    keyboard.text('← Назад', 'adm:home');
    return { text: '👤 Никого не нашёл.', keyboard };
  }
  for (const u of users) keyboard.text(`${displayName(u)} · ${u.tgId}`, `adm:user:${u.id}`).row();
  keyboard.text('← Назад', 'adm:home');
  return { text: `👤 Нашёл ${users.length}:`, keyboard };
}

export function renderUserCard(args: {
  card: UserCard;
  decks: Array<Deck & { owned: boolean }>;
  role: AdminRole | null;
  canModerate: boolean;
  balance: number;
  spent: number;
  invited: number;
  referrerName: string | null;
}): { text: string; keyboard: InlineKeyboard } {
  const { card, decks, role, canModerate, balance, spent, invited, referrerName } = args;
  const u = card.user;
  const s = card.stats;

  const banned = u.bannedUntil && u.bannedUntil > new Date();
  const accuracy = s.votesCast ? s.correctVotes / s.votesCast : 0;

  const text = [
    `👤 <b>${who(u)}</b>`,
    `id ${u.id} · tg_id <code>${u.tgId}</code>`,
    role ? `🔧 админ: <b>${role}</b>` : '',
    banned ? `🚫 <b>забанен до ${u.bannedUntil!.toLocaleString('ru-RU')}</b>` : '',
    u.blockedBot ? '⚠️ заблокировал бота' : '',
    '',
    `Первый раз: ${u.createdAt.toLocaleDateString('ru-RU')} · был(а): ${u.lastSeenAt.toLocaleString('ru-RU')}`,
    card.activeRoomCode ? `🎮 сейчас в комнате <code>${card.activeRoomCode}</code>` : '',
    '',
    '<b>📊 Игра</b>',
    `Партий: ${s.gamesPlayed} · обезьянкой: ${s.gamesAsMonkey} (выжил ${s.winsAsMonkey})`,
    `Побед мирным: ${s.winsAsPeasant} · точность голосов: ${pct(accuracy)}`,
    '',
    '<b>💰 Деньги</b>',
    `Счёт: ${balance} ${COIN} · потрачено: ${spent} ${COIN}`,
    `🎁 Привёл: ${invited}`,
    referrerName ? `↪️ Пришёл от: ${esc(referrerName)}` : '',
    '',
    `💬 Обращений: ${card.feedbackCount}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const keyboard = new InlineKeyboard();
  if (canModerate) {
    for (const d of decks.filter((d) => d.isPremium)) {
      keyboard
        .text(
          `${d.owned ? '➖ Забрать' : '➕ Выдать'} ${d.title}`,
          `adm:${d.owned ? 'revoke' : 'grant'}:${u.id}:${d.id}`,
        )
        .row();
    }
    keyboard.text(`${COIN} Изменить счёт`, `adm:bal:${u.id}`).row();
    keyboard.text(banned ? '✅ Разбанить' : '🚫 Забанить на 30 дней', `adm:ban:${u.id}`).row();
  }
  keyboard.text('← Назад', 'adm:home');
  return { text, keyboard };
}

// ─── комнаты ──────────────────────────────────────────────────────────────

export function renderRooms(args: {
  rooms: OpenRoom[];
  liveRounds: Map<number, { round: number; phase: string }>;
}): { text: string; keyboard: InlineKeyboard } {
  const { rooms, liveRounds } = args;

  const lines = rooms.length
    ? rooms.map((r) => {
        const live = liveRounds.get(r.room.id);
        const state = live ? `🎬 раунд ${live.round} (${live.phase})` : `💤 ${r.room.state}`;
        const age = Math.round((Date.now() - r.room.lastActivityAt.getTime()) / 60000);
        return `<code>${r.room.code}</code> · 👥 ${r.players} · ${state} · ${age} мин назад`;
      })
    : ['Пусто — сейчас никто не играет.'];

  const keyboard = new InlineKeyboard();
  for (const r of rooms.slice(0, 10)) {
    keyboard.text(`⏹ Закрыть ${r.room.code}`, `adm:kill:${r.room.id}`).row();
  }
  keyboard.text('🔄 Обновить', 'adm:rooms').text('← Назад', 'adm:home');

  return { text: ['🎮 <b>Живые комнаты</b>', '', ...lines].join('\n'), keyboard };
}

// ─── прочее ───────────────────────────────────────────────────────────────

export function renderDecks(
  decks: Array<Deck & { items: number; games: number }>,
  canEdit: boolean,
): { text: string; keyboard: InlineKeyboard } {
  const lines = decks.map(
    (d) =>
      `${d.isPremium ? '🔒' : '🆓'} <b>${esc(d.title)}</b> (<code>${d.slug}</code>)\n` +
      `     действий ${d.items} · партий ${d.games}${d.isPremium ? ` · ${d.priceRub} ₽` : ''}`,
  );

  const keyboard = new InlineKeyboard();
  if (canEdit) {
    for (const d of decks) keyboard.text(`✏️ ${d.title}`, `adm:deck:${d.id}`).row();
  }
  keyboard.text('← Назад', 'adm:home');

  return {
    text: [
      '🎴 <b>Колоды</b>',
      '',
      ...lines,
      ...(canEdit ? ['', '<i>Нажми на колоду, чтобы изменить список действий.</i>'] : []),
    ].join('\n'),
    keyboard,
  };
}

// ─── содержимое колоды ────────────────────────────────────────────────────

/** Сколько действий показываем в карточке колоды: дальше сообщение не читается. */
const DECK_PREVIEW = 30;

export function renderDeckCard(deck: Deck, actions: string[]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const shown = actions.slice(0, DECK_PREVIEW).map((a, i) => `${i + 1}. ${esc(a)}`);
  const rest = actions.length - shown.length;

  const text = [
    `🎴 <b>${esc(deck.title)}</b> (<code>${esc(deck.slug)}</code>)`,
    `${deck.isPremium ? `🔒 платная · ${deck.priceRub} ₽` : '🆓 бесплатная'} · действий: <b>${actions.length}</b>`,
    '',
    ...(shown.length ? shown : ['<i>Колода пуста.</i>']),
    ...(rest > 0 ? ['', `<i>…и ещё ${rest}</i>`] : []),
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('➕ Добавить действия', `adm:deckadd:${deck.id}`)
    .row()
    .text('♻️ Заменить все', `adm:deckset:${deck.id}`)
    .row()
    .text('← К колодам', 'adm:decks');

  return { text, keyboard };
}

/**
 * Заголовок приглашения несёт id колоды и режим: по нему разбираем реплай,
 * даже если состояние в памяти уже протухло или процесс перезапустили.
 */
export const DECK_PROMPT_RE = /^✏️ Колода #(\d+) · (замена|дополнение)/;

const modeWord = (mode: DeckEditMode): string => (mode === 'set' ? 'замена' : 'дополнение');

function deckPromptHead(deck: Deck, mode: DeckEditMode): string {
  return `✏️ <b>Колода #${deck.id} · ${modeWord(mode)}</b> — ${esc(deck.title)}`;
}

export function renderDeckPrompt(args: {
  deck: Deck;
  mode: DeckEditMode;
  /** сколько действий в колоде сейчас */
  current: number;
  /** ошибки предыдущей попытки — приглашение переиспользуется как отбойник */
  errors?: string[];
}): string {
  const { deck, mode, current, errors } = args;

  const what =
    mode === 'set'
      ? `Пришли <b>полный новый список</b> — он заменит все ${current} действий.`
      : 'Пришли действия, которые нужно добавить к уже существующим.';

  return [
    deckPromptHead(deck, mode),
    ...(errors?.length ? ['', '⚠️ <b>Не сохранил:</b>', ...errors.map((e) => `• ${esc(e)}`)] : []),
    '',
    what,
    'Ответом на это сообщение.',
    '',
    '<b>Формат: одно действие — одна строка.</b>',
    `• от ${ITEM_MIN_LEN} до ${ITEM_MAX_LEN} символов`,
    '• коротко и в инфинитиве: «Почесать затылок»',
    '• нумерацию и дефисы в начале строки срежу сам',
    '• повторы и пустые строки не пройдут',
    `• за раз не больше ${MAX_ITEMS} строк`,
    `• в колоде должно остаться минимум ${RULES.cardSize} действий`,
    '',
    '<b>Пример:</b>',
    '<pre>Посолить еду',
    'Чихнуть',
    'Поправить причёску</pre>',
    '',
    '/cancel — отменить.',
  ].join('\n');
}

export function renderDeckSaved(args: {
  deck: Deck;
  mode: DeckEditMode;
  added: number;
  total: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { deck, mode, added, total } = args;
  const head =
    mode === 'set'
      ? `♻️ Заменил содержимое «${esc(deck.title)}»: ${added} действий.`
      : `➕ Добавил ${added} действий в «${esc(deck.title)}».`;

  return {
    text: [
      '✅ <b>Сохранено</b>',
      '',
      head,
      `Теперь в колоде: <b>${total}</b>.`,
      '',
      '<i>Идущие партии не затронуты — они играют по списку, снятому на старте.</i>',
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text('🎴 Открыть колоду', `adm:deck:${deck.id}`)
      .row()
      .text('← Назад', 'adm:home'),
  };
}

export function renderTop(
  rows: Array<{ userId: number; name: string; gamesPlayed: number; wins: number }>,
): { text: string; keyboard: InlineKeyboard } {
  const lines = rows.length
    ? rows.map((r, i) => {
        const wins = `${r.wins} ${plural(r.wins, 'победа', 'победы', 'побед')}`;
        const games = `${r.gamesPlayed} ${plural(r.gamesPlayed, 'партию', 'партии', 'партий')}`;
        return `${i + 1}. ${esc(r.name)} — ${wins} за ${games}`;
      })
    : ['Пока никто не играл.'];
  return {
    text: ['🏆 <b>Лидеры</b>', '', ...lines].join('\n'),
    keyboard: new InlineKeyboard().text('← Назад', 'adm:home'),
  };
}

export function renderSystem(args: {
  uptimeSec: number;
  liveGames: number;
  pendingLocks: number;
  cachedUsers: number;
  analyticsBuffer: number;
  dbLatencyMs: number;
  memoryMb: number;
  admins: AdminRow[];
}): { text: string; keyboard: InlineKeyboard } {
  const h = Math.floor(args.uptimeSec / 3600);
  const m = Math.floor((args.uptimeSec % 3600) / 60);

  const text = [
    '⚙️ <b>Система</b>',
    '',
    `Аптайм: ${h} ч ${m} мин`,
    `Живых партий в памяти: ${args.liveGames}`,
    `Комнат под блокировкой: ${args.pendingLocks}`,
    `Пользователей в кеше: ${args.cachedUsers}`,
    `Событий в буфере: ${args.analyticsBuffer}`,
    `Задержка БД: ${args.dbLatencyMs} мс`,
    `Память: ${args.memoryMb} МБ`,
    '',
    '<b>Админы</b>',
    ...(args.admins.length
      ? args.admins.map((a) => `• ${who(a.user)} — ${a.role}`)
      : ['• только из ADMIN_IDS']),
  ].join('\n');

  return { text, keyboard: new InlineKeyboard().text('🔄 Обновить', 'adm:sys').text('← Назад', 'adm:home') };
}

// ─── статистика игрока (не админская) ─────────────────────────────────────

export function renderPlayerStats(args: {
  name: string;
  gamesPlayed: number;
  gamesAsMonkey: number;
  winsAsMonkey: number;
  winsAsPeasant: number;
  votesCast: number;
  correctVotes: number;
  /** сколько человек пришло по его пригласительной ссылке */
  referrals: number;
  /** 🍌 на счету; не показываем, если счёт пуст и приглашённых нет */
  balance?: number;
}): string {
  const {
    name, gamesPlayed, gamesAsMonkey, winsAsMonkey, winsAsPeasant,
    votesCast, correctVotes, referrals, balance = 0,
  } = args;

  // Приглашённые и счёт живут отдельно от партий: человек мог никого не
  // позвать, но привести десятерых, ни разу не доиграв до конца.
  const social = [
    `🎁 Привёл друзей: <b>${referrals}</b>`,
    ...(balance > 0 ? [`${COIN} На счету: <b>${balance}</b>`] : []),
  ];

  if (!gamesPlayed) {
    return [
      '📊 <b>Твоя статистика</b>',
      '',
      'Ты ещё не доиграл ни одной партии.',
      'Самое время — /start.',
      '',
      ...social,
    ].join('\n');
  }

  const monkeyRate = gamesAsMonkey ? winsAsMonkey / gamesAsMonkey : 0;
  const accuracy = votesCast ? correctVotes / votesCast : 0;

  return [
    `📊 <b>${esc(name)}</b>`,
    '',
    `Партий сыграно: <b>${gamesPlayed}</b>`,
    `🐒 Был обезьянкой: ${gamesAsMonkey}${gamesAsMonkey ? ` · выжил ${winsAsMonkey} (${pct(monkeyRate)})` : ''}`,
    `🕵️ Точность голосов: <b>${pct(accuracy)}</b> (${correctVotes} из ${votesCast})`,
    `✅ Побед мирным: ${winsAsPeasant}`,
    '',
    ...social,
  ].join('\n');
}

// ─── журнал событий ───────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  user_start: 'запустил бота',
  room_created: 'создал комнату',
  room_joined: 'вошёл в комнату',
  room_join_failed: 'не смог войти',
  room_code_changed: 'сменил код',
  room_closed: 'комната закрыта',
  deck_selected: 'выбрал колоду',
  deck_locked_hit: '🔒 тыкнул в платную колоду',
  game_started: 'партия начата',
  round_played: 'раунд сыгран',
  ballot_finished: 'голосование',
  game_finished: 'партия окончена',
  game_aborted: 'партия прервана',
  purchase_started: '🛒 начал покупку',
  purchase_paid: '💰 оплатил',
  shop_opened: 'открыл магазин',
  referral_attached: '🎁 пришёл по приглашению',
  referral_bonus: '🎁 начислен бонус',
  feedback_sent: 'написал обращение',
  feedback_reply_started: 'начал ответ',
  feedback_replied: 'ответил на обращение',
  bot_blocked: 'заблокировал бота',
};

/** Короткая сводка payload — в Telegram длинный jsonb читать невозможно. */
function briefly(row: EventRow): string {
  const p = row.payload;
  const parts: string[] = [];
  for (const key of ['reason', 'deckSlug', 'code', 'via', 'source', 'outcome', 'where', 'deckId', 'provider', 'kind', 'bonus']) {
    const v = p[key];
    if (v !== undefined && v !== null && v !== '') parts.push(String(v));
  }
  if (typeof p['amountMinor'] === 'number') parts.push(`${p['amountMinor']} ${String(p['currency'] ?? '')}`.trim());
  if (typeof p['targetUserId'] === 'number') parts.push(`→ id ${p['targetUserId']}`);
  if (row.roomId !== null && !parts.length) parts.push(`комната ${row.roomId}`);
  return parts.join(' · ');
}

export type JournalMode = 'admin' | 'pay' | 'all';

export function renderJournal(rows: EventRow[], mode: JournalMode): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const head =
    mode === 'admin' ? '📜 <b>Действия админов</b>'
    : mode === 'pay' ? '💰 <b>События оплаты</b>'
    : '📜 <b>Все события</b>';

  const lines = rows.length
    ? rows.map((r) => {
        const time = r.createdAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const who = r.actorName ? esc(r.actorName) : '—';
        const what =
          r.type === 'admin_action'
            ? `🔧 ${String(r.payload['action'] ?? 'действие')}`
            : (EVENT_LABELS[r.type] ?? r.type);
        const detail = briefly(r);
        return `<code>${time}</code> ${who} · ${what}${detail ? ` · ${esc(detail)}` : ''}`;
      })
    : ['Пока пусто.'];

  const keyboard = new InlineKeyboard()
    .text(mode === 'admin' ? '· Админы ·' : 'Админы', 'adm:log:admin')
    .text(mode === 'pay' ? '· Оплата ·' : 'Оплата', 'adm:log:pay')
    .text(mode === 'all' ? '· Всё ·' : 'Всё', 'adm:log:all')
    .row()
    .text('🔄 Обновить', `adm:log:${mode}`)
    .text('← Назад', 'adm:home');

  return {
    text: [
      head,
      '',
      ...lines,
      ...(mode === 'pay'
        ? ['', '<i>Подробный технический лог — в stdout под меткой mod=pay.</i>']
        : []),
    ].join('\n'),
    keyboard,
  };
}

// ─── тарифы и оплата ──────────────────────────────────────────────────────


/** Человеческие названия касс — в панели и в журнале платежей. */
const PROVIDER_LABELS: Record<string, string> = {
  stars: '⭐ Telegram Stars',
  yookassa: '💳 ЮKassa (карты, СБП)',
  cryptobot: '🪙 Crypto Pay',
  wallet: `${COIN} Личный счёт`,
  manual: '✋ Вручную',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '⏳ ждёт',
  paid: '✅ оплачен',
  canceled: '🚫 отменён',
  failed: '⚠️ ошибка',
  refunded: '↩️ возвращён',
};

/** Сумма в валюте платежа: складывать звёзды с рублями нельзя, поэтому и не складываем. */
function money(amountMinor: number, currency: string): string {
  if (currency === 'RUB') return `${rubles(amountMinor)} ₽`;
  if (currency === 'XTR') return `⭐ ${amountMinor}`;
  if (currency === 'COIN') return `${amountMinor} ${COIN}`;
  return `${amountMinor} ${currency}`;
}

export function renderPayHome(args: {
  revenue: Revenue[];
  economy: Economy;
  /** какие провайдеры реально настроены ключами */
  configured: Record<string, boolean>;
  days: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { revenue, economy, configured, days } = args;

  const revenueLines = revenue.length
    ? revenue.map(
        (r) => `• ${PROVIDER_LABELS[r.provider] ?? r.provider}: <b>${money(r.amountMinor, r.currency)}</b> (${r.count})`,
      )
    : ['• пока ничего не продано'];

  const providerLines = (['stars', 'yookassa', 'cryptobot', 'wallet'] as const).map((id) => {
    const on = economy.providers[id];
    // «Нет ключей» и «выключено» — разные состояния, и путать их дорого:
    // в первом случае кнопка в панели ничего не изменит.
    const missing = id !== 'wallet' && !configured[id];
    const mark = missing ? '⚠️ нет ключей' : on ? '✅ включён' : '⭕️ выключен';
    return `• ${PROVIDER_LABELS[id]} — ${mark}`;
  });

  const text = [
    '💰 <b>Оплата</b>',
    '',
    `<b>Выручка за ${days} дней</b>`,
    ...revenueLines,
    '',
    '<b>Способы оплаты</b>',
    ...providerLines,
    '',
    '⚠️ <i>Правила Telegram разрешают продавать цифровые товары внутри бота',
    'только за Stars. ЮKassa и крипту включай лишь для внешней витрины',
    'или физических товаров.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('🎴 Тарифы колод', 'adm:tariffs')
    .text('🧾 Платежи', 'adm:payments')
    .row()
    .text('🔌 Способы оплаты', 'adm:providers')
    .row()
    .text('🎁 Рефералка', 'adm:ref')
    .row()
    .text(days === 7 ? '· 7 дней ·' : '7 дней', 'adm:pay:7')
    .text(days === 30 ? '· 30 дней ·' : '30 дней', 'adm:pay:30')
    .row()
    .text('← Назад', 'adm:home');

  return { text, keyboard };
}

export function renderProviders(args: {
  economy: Economy;
  configured: Record<string, boolean>;
}): { text: string; keyboard: InlineKeyboard } {
  const { economy, configured } = args;

  const keyboard = new InlineKeyboard();
  for (const id of ['stars', 'yookassa', 'cryptobot', 'wallet'] as const) {
    const on = economy.providers[id];
    const missing = id !== 'wallet' && !configured[id];
    keyboard.text(`${missing ? '⚠️' : on ? '✅' : '⭕️'} ${PROVIDER_LABELS[id]}`, `adm:prov:${id}`).row();
  }
  keyboard.text('← Назад', 'adm:pay:7');

  return {
    text: [
      '🔌 <b>Способы оплаты</b>',
      '',
      'Нажми, чтобы включить или выключить.',
      '',
      '⚠️ — провайдер не настроен: нет ключей в окружении, включить нельзя.',
      '',
      '<i>Stars — единственный способ, разрешённый Telegram для цифровых',
      'товаров внутри бота. Остальные предназначены для внешней витрины.</i>',
    ].join('\n'),
    keyboard,
  };
}

export function renderTariffs(
  decks: Array<Deck & { items: number; games: number }>,
): { text: string; keyboard: InlineKeyboard } {
  const lines = decks.map((d) => {
    if (!d.isPremium) return `🆓 <b>${esc(d.title)}</b> — бесплатная`;
    const price = [
      d.priceRub > 0 ? `${d.priceRub} ₽` : null,
      d.priceStars > 0 ? `⭐ ${d.priceStars}` : null,
      d.priceCoins > 0 ? `${d.priceCoins} ${COIN}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return `${d.active ? '🔒' : '🚫'} <b>${esc(d.title)}</b> — ${price || 'цена не назначена'}`;
  });

  const keyboard = new InlineKeyboard();
  for (const d of decks) keyboard.text(`💲 ${d.title}`, `adm:tariff:${d.id}`).row();
  keyboard.text('← Назад', 'adm:pay:7');

  return {
    text: [
      '🎴 <b>Тарифы колод</b>',
      '',
      ...lines,
      '',
      '<i>🚫 — колода снята с продажи: купившие играют, новые не покупают.</i>',
    ].join('\n'),
    keyboard,
  };
}

export function renderTariffCard(deck: Deck): { text: string; keyboard: InlineKeyboard } {
  const text = [
    `💲 <b>${esc(deck.title)}</b> (<code>${esc(deck.slug)}</code>)`,
    '',
    `Статус: ${deck.isPremium ? '🔒 платная' : '🆓 бесплатная'}${deck.isPremium && !deck.active ? ' · 🚫 снята с продажи' : ''}`,
    '',
    '<b>Цены</b>',
    `• рубли (ЮKassa, крипта): <b>${deck.priceRub}</b> ₽`,
    `• Telegram Stars: <b>${deck.priceStars}</b> ⭐`,
    `• личный счёт: <b>${deck.priceCoins}</b> ${COIN}`,
    '',
    '<i>0 — этим способом колоду купить нельзя.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('₽ Рубли', `adm:price:${deck.id}:rub`)
    .text('⭐ Stars', `adm:price:${deck.id}:stars`)
    .text(`${COIN}`, `adm:price:${deck.id}:coins`)
    .row()
    .text(deck.isPremium ? '🆓 Сделать бесплатной' : '🔒 Сделать платной', `adm:premium:${deck.id}`)
    .row()
    .text(deck.active ? '🚫 Снять с продажи' : '✅ Вернуть в продажу', `adm:deckactive:${deck.id}`)
    .row()
    .text('← К тарифам', 'adm:tariffs');

  return { text, keyboard };
}

/** Заголовок несёт колоду и поле — по нему разбираем реплай без состояния в памяти. */
export const PRICE_PROMPT_RE = /^💲 Цена #(\d+) · (rub|stars|coins)/;

const PRICE_UNITS: Record<string, string> = { rub: '₽', stars: '⭐', coins: COIN };

export function renderPricePrompt(deck: Deck, field: 'rub' | 'stars' | 'coins', current: number): string {
  return [
    `💲 <b>Цена #${deck.id} · ${field}</b> — ${esc(deck.title)}`,
    '',
    `Сейчас: <b>${current}</b> ${PRICE_UNITS[field]}`,
    '',
    'Пришли новое число ответом на это сообщение.',
    '0 — отключить этот способ оплаты для колоды.',
    '',
    '/cancel — отменить.',
  ].join('\n');
}

export function renderReferral(e: Economy): { text: string; keyboard: InlineKeyboard } {
  const r = e.referral;
  const text = [
    '🎁 <b>Реферальная программа</b>',
    '',
    `Состояние: ${r.enabled ? '✅ включена' : '⭕️ выключена'}`,
    '',
    '<b>Бонусы</b>',
    `• приглашённому за первый запуск: <b>${r.inviteeBonus}</b> ${COIN}`,
    `• пригласившему за первую покупку друга: <b>${r.inviterBonus}</b> ${COIN}`,
    `• процент с покупок приглашённого: <b>${r.purchasePercent}%</b>`,
    `• потолок на одного реферала: <b>${r.perReferralCap || 'без потолка'}</b>`,
    '',
    '<b>Курс пополнения счёта</b>',
    `• за 1 ₽: <b>${e.rates.coinsPerRub}</b> ${COIN}`,
    `• за 1 ⭐: <b>${e.rates.coinsPerStar}</b> ${COIN}`,
    '',
    '<i>Приглашения записываются всегда, даже когда программа выключена —',
    'бонусы за них можно будет доначислить задним числом.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text(r.enabled ? '⭕️ Выключить' : '✅ Включить', 'adm:ref:toggle')
    .row()
    .text('Другу', 'adm:econ:inviteeBonus')
    .text('Пригласившему', 'adm:econ:inviterBonus')
    .row()
    .text('Процент', 'adm:econ:purchasePercent')
    .text('Потолок', 'adm:econ:perReferralCap')
    .row()
    .text(`${COIN} за ₽`, 'adm:econ:coinsPerRub')
    .text(`${COIN} за ⭐`, 'adm:econ:coinsPerStar')
    .row()
    .text('🏆 Кто приводит', 'adm:reftop')
    .row()
    .text('← Назад', 'adm:pay:7');

  return { text, keyboard };
}

export const ECON_PROMPT_RE = /^⚙️ Настройка · ([A-Za-z]+)/;

const ECON_LABELS: Record<string, string> = {
  inviteeBonus: `бонус приглашённому, ${COIN}`,
  inviterBonus: `бонус пригласившему, ${COIN}`,
  purchasePercent: 'процент с покупок реферала, %',
  perReferralCap: `потолок начислений на реферала, ${COIN} (0 — без потолка)`,
  coinsPerRub: `${COIN} за 1 ₽ при пополнении`,
  coinsPerStar: `${COIN} за 1 ⭐ при пополнении`,
};

export function renderEconPrompt(field: string, current: number): string {
  return [
    `⚙️ <b>Настройка · ${field}</b>`,
    '',
    ECON_LABELS[field] ?? field,
    `Сейчас: <b>${current}</b>`,
    '',
    'Пришли новое число ответом на это сообщение.',
    '',
    '/cancel — отменить.',
  ].join('\n');
}

export function renderReferralTop(rows: TopReferrer[]): { text: string; keyboard: InlineKeyboard } {
  const lines = rows.length
    ? rows.map((r, i) => `${i + 1}. ${esc(r.name)} — ${r.invited} чел., ${r.earned} ${COIN}`)
    : ['Пока никто никого не привёл.'];

  const keyboard = new InlineKeyboard();
  for (const r of rows.slice(0, 8)) keyboard.text(`👤 ${r.name}`, `adm:user:${r.userId}`).row();
  keyboard.text('← Назад', 'adm:ref');

  return { text: ['🏆 <b>Кто приводит людей</b>', '', ...lines].join('\n'), keyboard };
}

export function renderPayments(rows: PaymentRow[]): { text: string; keyboard: InlineKeyboard } {
  const lines = rows.length
    ? rows.map((p) => {
        const when = p.createdAt.toLocaleString('ru-RU', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        const what = p.kind === 'topup' ? `${p.coinsAmount} ${COIN}` : (p.deckTitle ?? 'колода');
        return `<code>${when}</code> ${esc(p.userName)} · ${esc(what)} · ${money(p.amountMinor, p.currency)} · ${STATUS_LABELS[p.status] ?? p.status}`;
      })
    : ['Платежей пока не было.'];

  const keyboard = new InlineKeyboard();
  // Возврат предлагаем только по проведённым: у остальных возвращать нечего.
  for (const p of rows.filter((r) => r.status === 'paid').slice(0, 8)) {
    keyboard.text(`↩️ Вернуть #${p.id} (${money(p.amountMinor, p.currency)})`, `adm:refund:${p.id}`).row();
  }
  keyboard.text('🔄 Обновить', 'adm:payments').text('← Назад', 'adm:pay:7');

  return { text: ['🧾 <b>Последние платежи</b>', '', ...lines].join('\n'), keyboard };
}

export const BALANCE_PROMPT_RE = /^💰 Баланс #(\d+)/;

export function renderBalancePrompt(userId: number, name: string, balance: number): string {
  return [
    `💰 <b>Баланс #${userId}</b> — ${esc(name)}`,
    '',
    `Сейчас: <b>${coins(balance)}</b> ${COIN}`,
    '',
    'Пришли сумму со знаком ответом на это сообщение:',
    '<code>+100</code> — начислить, <code>-50</code> — списать.',
    '',
    '/cancel — отменить.',
  ].join('\n');
}
