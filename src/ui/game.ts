import { InlineKeyboard } from 'grammy';
import { maxRounds } from '../domain/rules.js';

const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Карточка висит открытой всю партию — ни кнопки, ни таймера. */
export function renderCard(code: string, actions: string[], isMonkey: boolean): string {
  const lines = isMonkey
    ? actions.map((_, i) => `${i + 1}. 🐒 ты обезьянка`)
    : actions.map((a, i) => `${i + 1}. ${esc(a)}`);

  const footer = isMonkey
    ? ['', '🐒 <b>Списка ты не знаешь.</b>', 'По сигналу смотри на других и повторяй — быстро.']
    : [];

  return [`🎴 <b>Твоя карточка</b> · комната <code>${code}</code>`, '', ...lines, ...footer].join('\n');
}

// ─── раунд ────────────────────────────────────────────────────────────────

const roundHead = (round: number) => `🎬 <b>Раунд ${round}</b> из ${maxRounds}`;

export function renderWaiting(round: number, isAdmin: boolean): string {
  return [
    roundHead(round),
    '',
    isAdmin ? 'Все готовы? Жми — пойдёт отсчёт.' : 'Ждём админа…',
    '',
    '<i>Звук лучше включить.</i>',
  ].join('\n');
}

export function renderCountdown(round: number, left: number): string {
  return [roundHead(round), '', DIGITS[left] ?? String(left), '', 'Приготовились…'].join('\n');
}

/** Схлопнутый отсчёт: один кадр вместо трёх цифр, когда партий много. */
export function renderGetReady(round: number): string {
  return [roundHead(round), '', '⏳', '', 'Приготовились…'].join('\n');
}

export function renderReveal(round: number, actionNumber: number, isMonkey: boolean): string {
  if (isMonkey) return [roundHead(round), '', '🐒', '', '<b>КОПИРУЙ!</b>'].join('\n');
  return [roundHead(round), '', DIGITS[actionNumber] ?? String(actionNumber), '', '<b>ДЕЛАЙ!</b>'].join('\n');
}

export const goKeyboard = (round: number) =>
  new InlineKeyboard()
    .text(round === 1 ? '▶️ Погнали' : '▶️ Следующий раунд', 'g:go')
    .row()
    .text('⏹ Завершить игру', 'g:end');

export const afterRoundKeyboard = (voteTime: boolean) =>
  new InlineKeyboard()
    .text(voteTime ? '🗳 Голосовать' : '▶️ Следующий раунд', voteTime ? 'g:vote' : 'g:go')
    .row()
    .text('⏹ Завершить игру', 'g:end');

// ─── голосование ──────────────────────────────────────────────────────────

export interface Candidate {
  userId: number;
  name: string;
}

export function renderVoting(args: {
  round: number;
  revote: boolean;
  candidates: Candidate[];
  myVoteName?: string;
  /** этот игрок воздержался */
  mySkipped: boolean;
  /** можно ли воздержаться в этом бюллетене — в последнем раунде нельзя */
  canSkip: boolean;
  voted: number;
  total: number;
}): { text: string; keyboard?: InlineKeyboard } {
  const { round, revote, candidates, myVoteName, mySkipped, canSkip, voted, total } = args;

  const head = revote ? '🗳 <b>Переголосование</b>' : '🗳 <b>Голосование</b>';
  const sub = revote ? 'Голоса разделились поровну — выбираем между лидерами.' : 'Кто из них обезьянка?';

  if (myVoteName || mySkipped) {
    return {
      text: [
        head,
        '',
        mySkipped ? '⏭ Ты пропустил голосование.' : `Твой голос: <b>${esc(myVoteName!)}</b> ✅`,
        '',
        `Ждём остальных — ${voted} из ${total}.`,
      ].join('\n'),
    };
  }

  // `row()` всегда открывает новую строку, поэтому зовём его между кнопками,
  // а не после каждой: иначе в клавиатуре остаётся пустой хвост.
  const keyboard = new InlineKeyboard();
  candidates.forEach((c, i) => {
    if (i > 0) keyboard.row();
    keyboard.text(c.name, `v:${c.userId}`);
  });
  if (canSkip) {
    if (candidates.length) keyboard.row();
    keyboard.text('⏭ Пропустить', 'v:skip');
  }

  // Ни счётчика, ни прочей меняющейся цифры: сообщение неответившего
  // рисуется один раз за бюллетень и больше не трогается. `canSkip` внутри
  // бюллетеня не меняется, так что отпечаток остаётся стабильным.
  return {
    text: [
      head,
      '',
      sub,
      ...(canSkip ? [] : ['<i>Последний раунд — пропустить нельзя.</i>']),
      '',
      `<i>После ${round} раунда</i>`,
    ].join('\n'),
    keyboard,
  };
}

/**
 * Бюллетень не состоялся. Раскладку голосов и обвинённого намеренно не
 * показываем: голосования как бы и не было, а раскрытая роль осталась бы
 * раскрытой навсегда.
 */
export function renderNoQuorum(votesCast: number, total: number): string {
  return [
    '🗳 <b>Голосование не состоялось</b>',
    '',
    `Проголосовали ${votesCast} из ${total} — большинство пропустило.`,
    'Ничего не раскрываем, играем дальше.',
  ].join('\n');
}

export function renderTie(counts: Array<{ name: string; votes: number }>): string {
  return [
    '🤝 <b>Снова ничья</b>',
    '',
    ...counts.map((c) => `${esc(c.name)} — ${c.votes}`),
    '',
    'Никого не поймали. Обезьянка живёт дальше.',
  ].join('\n');
}

export function renderVoteResult(args: {
  counts: Array<{ name: string; votes: number }>;
  accusedName: string;
  caught: boolean;
}): string {
  const { counts, accusedName, caught } = args;
  return [
    '🗳 <b>Итоги голосования</b>',
    '',
    ...counts.map((c) => `${esc(c.name)} — ${c.votes}`),
    '',
    caught
      ? `✅ <b>${esc(accusedName)}</b> — обезьянка! Поймали.`
      : `❌ <b>${esc(accusedName)}</b> не обезьянка. Она среди вас и играет дальше.`,
  ].join('\n');
}

// ─── финал ────────────────────────────────────────────────────────────────

export function renderFinal(args: {
  peasantsWon: boolean;
  monkeyNames: string[];
  rounds: number;
  ballots: number;
}): string {
  const { peasantsWon, monkeyNames, rounds, ballots } = args;
  const many = monkeyNames.length > 1;

  return [
    '🏁 <b>Игра окончена</b>',
    '',
    peasantsWon
      ? `✅ <b>Мирные победили</b> — ${many ? 'обезьянок' : 'обезьянку'} нашли.`
      : `🐒 <b>${many ? 'Обезьянки победили' : 'Обезьянка победила'}</b> — продержалась все ${rounds} раундов.`,
    '',
    `🐒 ${many ? 'Обезьянками были' : 'Обезьянкой была'}: <b>${monkeyNames.map(esc).join(', ')}</b>`,
    '',
    `<i>Раундов сыграно: ${rounds} · голосований: ${ballots}</i>`,
  ].join('\n');
}

export const againKeyboard = () =>
  new InlineKeyboard().text('🔄 Ещё раз', 'g:again').row().text('💡 Написать разработчикам', 'fb:new');

/** Тем, кто не админ: сыграть ещё решает админ, а написать нам может каждый. */
export const finalGuestKeyboard = () =>
  new InlineKeyboard().text('💡 Написать разработчикам', 'fb:new');

export const renderAborted = (reason: string) => ['⏹ <b>Игра прервана</b>', '', reason].join('\n');
