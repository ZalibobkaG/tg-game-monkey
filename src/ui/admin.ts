import { InlineKeyboard } from 'grammy';
import type { DeckUsage, EventRow, PeriodStats, SignalHealth, UserCard } from '../repo/stats.js';
import type { Deck } from '../repo/decks.js';
import type { OpenRoom } from '../repo/rooms.js';
import type { AdminRole, AdminRow } from '../repo/admins.js';
import type { User } from '../repo/users.js';
import { displayName } from '../repo/users.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
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
}): { text: string; keyboard: InlineKeyboard } {
  const { card, decks, role, canModerate } = args;
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
    `Очков всего: ${s.pointsTotal}`,
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

export function renderDecks(decks: Array<Deck & { items: number; games: number }>): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines = decks.map(
    (d) =>
      `${d.isPremium ? '🔒' : '🆓'} <b>${esc(d.title)}</b> (<code>${d.slug}</code>)\n` +
      `     действий ${d.items} · партий ${d.games}${d.isPremium ? ` · ${d.priceRub} ₽` : ''}`,
  );
  return {
    text: ['🎴 <b>Колоды</b>', '', ...lines].join('\n'),
    keyboard: new InlineKeyboard().text('← Назад', 'adm:home'),
  };
}

export function renderTop(
  rows: Array<{ userId: number; name: string; gamesPlayed: number; pointsTotal: number }>,
): { text: string; keyboard: InlineKeyboard } {
  const lines = rows.length
    ? rows.map((r, i) => `${i + 1}. ${esc(r.name)} — ${r.pointsTotal} очк. за ${r.gamesPlayed} партий`)
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
  pointsTotal: number;
}): string {
  const { name, gamesPlayed, gamesAsMonkey, winsAsMonkey, winsAsPeasant, votesCast, correctVotes } = args;

  if (!gamesPlayed) {
    return ['📊 <b>Твоя статистика</b>', '', 'Ты ещё не доиграл ни одной партии.', 'Самое время — /start.'].join(
      '\n',
    );
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
    `🏆 Очков всего: <b>${args.pointsTotal}</b>`,
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
  feedback_sent: 'написал обращение',
  feedback_reply_started: 'начал ответ',
  feedback_replied: 'ответил на обращение',
  bot_blocked: 'заблокировал бота',
};

/** Короткая сводка payload — в Telegram длинный jsonb читать невозможно. */
function briefly(row: EventRow): string {
  const p = row.payload;
  const parts: string[] = [];
  for (const key of ['reason', 'deckSlug', 'code', 'via', 'source', 'outcome', 'where', 'deckId']) {
    const v = p[key];
    if (v !== undefined && v !== null && v !== '') parts.push(String(v));
  }
  if (typeof p['targetUserId'] === 'number') parts.push(`→ id ${p['targetUserId']}`);
  if (row.roomId !== null && !parts.length) parts.push(`комната ${row.roomId}`);
  return parts.join(' · ');
}

export function renderJournal(rows: EventRow[], mode: 'admin' | 'all'): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const head = mode === 'admin' ? '📜 <b>Действия админов</b>' : '📜 <b>Все события</b>';

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
    .text(mode === 'all' ? '· Всё ·' : 'Всё', 'adm:log:all')
    .row()
    .text('← Назад', 'adm:home');

  return { text: [head, '', ...lines].join('\n'), keyboard };
}
