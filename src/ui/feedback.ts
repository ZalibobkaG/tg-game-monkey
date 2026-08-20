import { InlineKeyboard } from 'grammy';
import type { FeedbackKind, FeedbackStatus, FeedbackWithUser } from '../repo/feedback.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const KIND_LABELS: Record<FeedbackKind, string> = {
  idea: '💡 Идея',
  bug: '🐞 Баг',
  deck: '🎴 Идея колоды',
  other: '💬 Другое',
};

/** Короткий значок вида — для тесных кнопок инбокса. */
const KIND_EMOJI: Record<FeedbackKind, string> = {
  idea: '💡',
  bug: '🐞',
  deck: '🎴',
  other: '💬',
};

function formatDate(d: Date): string {
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function renderKindPicker(): { text: string; keyboard: InlineKeyboard } {
  const text = 'О чём напишешь?';
  const keyboard = new InlineKeyboard()
    .text(KIND_LABELS.idea, 'fb:kind:idea')
    .text(KIND_LABELS.bug, 'fb:kind:bug')
    .row()
    .text(KIND_LABELS.deck, 'fb:kind:deck')
    .text(KIND_LABELS.other, 'fb:kind:other')
    .row()
    .text('← Отмена', 'fb:cancel');
  return { text, keyboard };
}

export function renderPrompt(kind: FeedbackKind): string {
  return [
    KIND_LABELS[kind],
    '',
    'Пиши одним сообщением — от 10 до 2000 символов.',
    '<code>/cancel</code> — чтобы отменить.',
  ].join('\n');
}

/**
 * Приглашение админу ответить. Номер обращения зашит в текст намеренно:
 * по нему мы восстанавливаем контекст из `reply_to_message`, не заглядывая
 * в состояние процесса.
 */
export function renderReplyPrompt(id: number): string {
  return [
    `✍️ Ответ на обращение №${id}`,
    '',
    'Напиши текст ответом на это сообщение.',
    '<code>/cancel</code> — отменить.',
  ].join('\n');
}

/**
 * Ссылка на обращение внутри наших же сообщений — и в карточке админа
 * («· обращение #42»), и в приглашении ответить («Ответ на обращение №42»).
 * Админ может ответить реплаем на любое из них, поэтому шаблон один
 * и живёт рядом с рендерами: меняются вместе.
 */
export const FEEDBACK_REF_RE = /(?:· обращение #|Ответ на обращение №)(\d+)/;

/** Обратный разбор приглашения пользователю: по первой строке узнаём тему. */
export function kindFromPrompt(text: string): FeedbackKind | null {
  const head = text.split('\n')[0]?.trim() ?? '';
  const kinds = Object.keys(KIND_LABELS) as FeedbackKind[];
  return kinds.find((k) => KIND_LABELS[k] === head) ?? null;
}

export function renderSent(id: number): string {
  return `✅ Обращение #${id} отправлено. Ответ придёт сюда же.`;
}

export function renderTooOften(limit: number): string {
  return `⏳ Многовато обращений подряд — не больше ${limit} в час. Попробуй чуть позже.`;
}

export function renderTooShort(min: number): string {
  return `⚠️ Коротковато — минимум ${min} символов.`;
}

export function renderTooLong(max: number): string {
  return `⚠️ Многовато — максимум ${max} символов.`;
}

export function renderAdminCard(args: {
  fb: FeedbackWithUser;
  gamesPlayed: number;
  roomCode?: string | null;
}): { text: string; keyboard: InlineKeyboard } {
  const { fb, gamesPlayed, roomCode } = args;
  const name = fb.user.firstName.trim() || 'Без имени';
  const username = fb.user.username ? ` @${esc(fb.user.username)}` : '';

  const lines = [
    `${KIND_LABELS[fb.kind]} · обращение #${fb.id}`,
    '',
    `👤 ${esc(name)}${username}`,
    `id ${fb.user.id} · tg ${fb.user.tgId} · партий: ${gamesPlayed}`,
  ];
  if (roomCode) lines.push(`🚪 Комната <code>${esc(roomCode)}</code>`);
  lines.push(`🕒 ${formatDate(fb.createdAt)}`, '', esc(fb.text));

  if (fb.status === 'answered' && fb.reply) {
    const when = fb.answeredAt ? ` (${formatDate(fb.answeredAt)})` : '';
    lines.push('', `💬 <b>Ответ${when}:</b>`, esc(fb.reply));
  }

  const keyboard = new InlineKeyboard();
  if (fb.status !== 'answered') keyboard.text('✍️ Ответить', `fbadm:reply:${fb.id}`);
  keyboard.text('👌 Прочитано', `fbadm:read:${fb.id}`).row();
  keyboard.text('🚫 Спам', `fbadm:spam:${fb.id}`).text('🗄 В архив', `fbadm:arch:${fb.id}`);

  return { text: lines.join('\n'), keyboard };
}

export function renderUserReply(kind: FeedbackKind, reply: string): string {
  return ['💬 <b>Ответ от команды «Обезьянки»</b>', KIND_LABELS[kind], '', esc(reply)].join('\n');
}

export function renderInbox(
  items: FeedbackWithUser[],
  counts: Record<FeedbackStatus, number>,
): { text: string; keyboard: InlineKeyboard } {
  const countsLine = `🆕 ${counts.new} · 👌 ${counts.read} · ✍️ ${counts.answered} · 🗄 ${counts.archived} · 🚫 ${counts.spam}`;
  const lines = ['📮 <b>Обращения</b>', countsLine, ''];

  if (items.length === 0) {
    lines.push('Пусто — новых обращений нет.');
    return { text: lines.join('\n'), keyboard: new InlineKeyboard() };
  }

  const keyboard = new InlineKeyboard();
  for (const fb of items) {
    const name = fb.user.firstName.trim() || 'Без имени';
    const preview = fb.text.length > 50 ? `${fb.text.slice(0, 50)}…` : fb.text;
    lines.push(`#${fb.id} ${KIND_LABELS[fb.kind]} · ${esc(name)} — ${esc(preview)}`);
    keyboard.text(`#${fb.id} ${KIND_EMOJI[fb.kind]} ${name}`, `fbadm:open:${fb.id}`).row();
  }

  return { text: lines.join('\n'), keyboard };
}
