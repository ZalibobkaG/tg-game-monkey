import { InlineKeyboard } from 'grammy';
import { RULES } from '../domain/rules.js';
import { esc } from './lobby.js';

const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export const showCardKeyboard = () => new InlineKeyboard().text('👀 Показать карточку', 'g:show');

export function renderCardHidden(code: string): string {
  return [
    `🎴 <b>Твоя карточка</b> · комната <code>${code}</code>`,
    '',
    'Открой и запомни — во время раунда будет некогда.',
    `Через ${RULES.cardRevealSeconds} секунд спрячется обратно, чтобы сосед не подсмотрел.`,
  ].join('\n');
}

/** У мирных и у обезьянки одинаковая шапка и одинаковое число строк — чтобы взгляд со стороны ничего не выдал. */
export function renderCardOpen(actions: string[], isMonkey: boolean): string {
  const lines = isMonkey
    ? actions.map((_, i) => `${i + 1}. 🐒 ты обезьянка`)
    : actions.map((a, i) => `${i + 1}. ${esc(a)}`);

  const footer = isMonkey
    ? ['', '🐒 <b>Списка ты не знаешь.</b>', 'По сигналу смотри на других и повторяй — быстро.']
    : ['', '<i>Запомни номера. По сигналу придёт только цифра.</i>'];

  return ['🎴 <b>Твоя карточка</b>', '', ...lines, ...footer, '', `⏳ спрячется через ${RULES.cardRevealSeconds} сек`].join('\n');
}

/** Карточка после игры: раскрыта навсегда, без кнопки и таймера. */
export function renderCardFinal(actions: string[], isMonkey: boolean): string {
  const lines = isMonkey
    ? actions.map((_, i) => `${i + 1}. 🐒 ты обезьянка`)
    : actions.map((a, i) => `${i + 1}. ${esc(a)}`);
  return ['🎴 <b>Твоя карточка была такой</b>', '', ...lines].join('\n');
}

export function renderWaiting(round: number, total: number, isAdmin: boolean): string {
  return [
    `🎬 <b>Раунд ${round} из ${total}</b>`,
    '',
    isAdmin ? 'Все готовы? Жми — пойдёт отсчёт.' : 'Ждём админа…',
    '',
    '<i>Звук лучше включить.</i>',
  ].join('\n');
}

export function renderCountdown(round: number, total: number, left: number): string {
  return [`🎬 <b>Раунд ${round} из ${total}</b>`, '', DIGITS[left] ?? String(left), '', 'Приготовились…'].join('\n');
}

export function renderReveal(round: number, total: number, actionNumber: number, isMonkey: boolean): string {
  if (isMonkey) {
    return [`🎬 <b>Раунд ${round} из ${total}</b>`, '', '🐒', '', '<b>КОПИРУЙ!</b>'].join('\n');
  }
  return [
    `🎬 <b>Раунд ${round} из ${total}</b>`,
    '',
    DIGITS[actionNumber] ?? String(actionNumber),
    '',
    '<b>ДЕЛАЙ!</b>',
  ].join('\n');
}

export function goKeyboard(round: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(round === 1 ? '▶️ Погнали' : '▶️ Следующий раунд', 'g:go')
    .row()
    .text('⏹ Завершить игру', 'g:end');
}

export function afterRoundKeyboard(isLast: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(isLast ? '🏁 Итог' : '▶️ Следующий раунд', isLast ? 'g:finish' : 'g:go')
    .row()
    .text('⏹ Завершить игру', 'g:end');
}

export function renderFinal(args: {
  monkeyNames: string[];
  actions: string[];
  playedNumbers: number[];
}): string {
  const { monkeyNames, actions, playedNumbers } = args;
  return [
    '🏁 <b>Игра окончена</b>',
    '',
    monkeyNames.length === 1 ? '🐒 Обезьянкой был:' : '🐒 Обезьянками были:',
    ...monkeyNames.map((n) => `<b>${esc(n)}</b>`),
    '',
    '<b>Что разыгрывали:</b>',
    ...playedNumbers.map((n, i) => `${i + 1} раунд — №${n + 1} ${esc(actions[n] ?? '')}`),
    '',
    '<i>Голосование в боте появится в следующем обновлении — пока обсудите вживую.</i>',
  ].join('\n');
}

export const againKeyboard = () => new InlineKeyboard().text('🔄 Ещё раз', 'g:again');

export function renderAborted(reason: string): string {
  return ['⏹ <b>Игра прервана</b>', '', reason].join('\n');
}
