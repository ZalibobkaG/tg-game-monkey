import { Composer } from 'grammy';
import type { BotContext } from '../types.js';
import * as R from '../repo/rooms.js';
import { abortGame, castVote, getLive, runRound, slotOf, startVoting } from '../services/game.js';
import type { LiveGame, Slot } from '../services/game.js';
import { openLobbyFor } from '../services/lobby.js';

export const gameHandler = new Composer<BotContext>();

async function liveFor(ctx: BotContext): Promise<{ game: LiveGame; slot: Slot } | null> {
  const room = await R.activeRoomOf(ctx.user.id);
  const game = room ? getLive(room.id) : undefined;
  if (!game) {
    await ctx.answerCallbackQuery({ text: 'Эта игра уже закончилась.', show_alert: true });
    return null;
  }
  const slot = slotOf(game, ctx.user.id);
  if (!slot) {
    await ctx.answerCallbackQuery({ text: 'Тебя нет среди игроков этой партии.', show_alert: true });
    return null;
  }
  return { game, slot };
}

async function adminLive(ctx: BotContext): Promise<LiveGame | null> {
  const found = await liveFor(ctx);
  if (!found) return null;
  if (found.game.adminUserId !== ctx.user.id) {
    await ctx.answerCallbackQuery({ text: 'Это может только админ комнаты.', show_alert: true });
    return null;
  }
  return found.game;
}

gameHandler.callbackQuery('g:go', async (ctx) => {
  const game = await adminLive(ctx);
  if (!game) return;
  if (game.phase === 'countdown') {
    await ctx.answerCallbackQuery({ text: 'Отсчёт уже идёт.' });
    return;
  }
  await ctx.answerCallbackQuery();
  await runRound(ctx.api, game.roomId);
});

gameHandler.callbackQuery('g:vote', async (ctx) => {
  const game = await adminLive(ctx);
  if (!game) return;
  if (game.phase === 'voting') {
    await ctx.answerCallbackQuery({ text: 'Голосование уже идёт.' });
    return;
  }
  await ctx.answerCallbackQuery();
  await startVoting(ctx.api, game.roomId);
});

gameHandler.callbackQuery(/^v:(\d+)$/, async (ctx) => {
  const found = await liveFor(ctx);
  if (!found) return;
  const { game } = found;
  if (game.phase !== 'voting') {
    await ctx.answerCallbackQuery({ text: 'Голосование уже закончилось.' });
    return;
  }
  const targetId = Number(ctx.match![1]);
  if (targetId === ctx.user.id) {
    await ctx.answerCallbackQuery({ text: 'За себя голосовать нельзя.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Голос принят.' });
  await castVote(ctx.api, game.roomId, ctx.user.id, targetId);
});

gameHandler.callbackQuery('g:end', async (ctx) => {
  const game = await adminLive(ctx);
  if (!game) return;
  await ctx.answerCallbackQuery();
  await abortGame(ctx.api, game.roomId, 'Админ завершил игру досрочно.');
  await backToLobby(ctx, game.roomId);
});

gameHandler.callbackQuery('g:again', async (ctx) => {
  const room = await R.activeRoomOf(ctx.user.id);
  if (!room) {
    await ctx.answerCallbackQuery({ text: 'Комната уже закрыта.', show_alert: true });
    return;
  }
  if (room.adminUserId !== ctx.user.id) {
    await ctx.answerCallbackQuery({ text: 'Это может только админ комнаты.', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await backToLobby(ctx, room.id);
});

async function backToLobby(ctx: BotContext, roomId: number): Promise<void> {
  const members = await R.listMembers(roomId);
  await Promise.all(members.map((m) => openLobbyFor(ctx.api, roomId, m.userId)));
}
