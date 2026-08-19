import { InlineKeyboard } from 'grammy';
import type { Deck } from '../repo/decks.js';
import type { Member, Room } from '../repo/rooms.js';
import { displayName } from '../repo/users.js';
import { RULES, canStart, monkeyCount, voteEveryLabel } from '../domain/rules.js';
import { deepLink } from '../config.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function playerList(members: Member[], room: Room, viewerUserId?: number): string {
  return members
    .map((m, i) => {
      const marks = [
        m.userId === room.adminUserId ? '👑' : '',
        m.userId === viewerUserId ? '← ты' : '',
        m.dmOk ? '' : '⚠️',
      ]
        .filter(Boolean)
        .join(' ');
      return `${i + 1}. ${esc(displayName(m.user))}${marks ? ' ' + marks : ''}`;
    })
    .join('\n');
}

function statusLine(count: number): string {
  const check = canStart(count);
  if (check.ok) {
    const monkeys = monkeyCount(count);
    return `✅ Можно начинать · обезьянок: ${monkeys}`;
  }
  const need = RULES.minPlayers - count;
  return need > 0 ? `⏳ Ждём ещё ${need} чел.` : `⚠️ ${check.reason}`;
}

export function renderLobby(args: {
  room: Room;
  members: Member[];
  deck?: Deck;
  viewerUserId: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { room, members, deck, viewerUserId } = args;
  const isAdmin = room.adminUserId === viewerUserId;

  const text = [
    '🐒 <b>Обезьянка</b>',
    `Комната <code>${room.code}</code>`,
    '',
    `👥 Игроки — ${members.length}`,
    playerList(members, room, viewerUserId),
    '',
    `🎴 Колода: <b>${esc(deck?.title ?? '—')}</b>`,
    `🗳 Голосование: <b>${voteEveryLabel(room.voteEvery)}</b>`,
    '',
    statusLine(members.length),
  ].join('\n');

  const keyboard = new InlineKeyboard();
  if (isAdmin) {
    keyboard.text('🎴 Колода', 'lb:deck').text('🗳 Голосование', 'lb:vote').row();
    keyboard.text('📷 Показать QR', 'lb:qr').row();
    keyboard.text('▶️ Начать игру', 'lb:start').row();
    keyboard.text('🚪 Закрыть комнату', 'lb:close');
  } else {
    keyboard.text('🚪 Выйти', 'lb:leave');
  }
  return { text, keyboard };
}

export function renderDeckPicker(args: {
  room: Room;
  decks: Array<Deck & { owned: boolean }>;
}): { text: string; keyboard: InlineKeyboard } {
  const { room, decks } = args;
  const text = [
    '🎴 <b>Выбери колоду</b>',
    '',
    ...decks.map((d) => {
      const mark = d.id === room.deckId ? '▸ ' : '   ';
      const lock = d.owned ? '' : ` 🔒 ${d.priceRub} ₽`;
      return `${mark}<b>${esc(d.title)}</b>${lock}\n     <i>${esc(d.description)}</i>`;
    }),
  ].join('\n');

  const keyboard = new InlineKeyboard();
  for (const d of decks) {
    const label = `${d.id === room.deckId ? '✅ ' : ''}${d.title}${d.owned ? '' : ' 🔒'}`;
    keyboard.text(label, `lb:deck:${d.id}`).row();
  }
  keyboard.text('← Назад', 'lb:back');
  return { text, keyboard };
}

export function renderGroupLobby(args: {
  room: Room;
  members: Member[];
  deck?: Deck;
}): { text: string; keyboard: InlineKeyboard } {
  const { room, members, deck } = args;
  const text = [
    '🐒 <b>Игра «Обезьянка»</b>',
    `Комната <code>${room.code}</code>`,
    '',
    `👥 Игроки — ${members.length}`,
    playerList(members, room),
    '',
    `🎴 ${esc(deck?.title ?? '—')} · 🗳 ${voteEveryLabel(room.voteEvery)}`,
    '',
    statusLine(members.length),
    '',
    '<i>Жми кнопку — карточка придёт в личку.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard().url('🎮 Войти в игру', deepLink(room.code));
  return { text, keyboard };
}

export function renderClosed(room: Room): string {
  return `🐒 Комната <code>${room.code}</code> закрыта.`;
}
