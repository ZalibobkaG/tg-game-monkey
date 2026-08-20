import { Api } from 'grammy';
import * as R from '../repo/rooms.js';
import { abortGame, liveGames } from './game.js';
import { closeLobby } from './lobby.js';
import { log } from '../lib/log.js';
import { track } from './analytics.js';

/**
 * Уборщик. Без него брошенное лобби держит свой код навсегда, а партия,
 * где админ ушёл спать на середине, вечно висит в памяти — и то и другое
 * копится тем быстрее, чем больше параллельных сессий.
 */
const SWEEP_MS = 5 * 60 * 1000;
const LOBBY_TTL_MS = 3 * 60 * 60 * 1000;
const GAME_TTL_MS = 60 * 60 * 1000;

async function sweep(api: Api): Promise<void> {
  const now = Date.now();

  for (const game of liveGames()) {
    if (now - game.lastActivity < GAME_TTL_MS) continue;
    log.info({ roomId: game.roomId, code: game.code }, '🧹 добиваю брошенную партию');
    await abortGame(api, game.roomId, 'Партию давно никто не продолжал — закрыл её.').catch((e) =>
      log.error({ err: e, roomId: game.roomId }, 'janitor: не смог прервать партию'),
    );
  }

  const stale = await R.staleLobbies(new Date(now - LOBBY_TTL_MS));
  for (const room of stale) {
    log.info({ roomId: room.id, code: room.code }, '🧹 закрываю брошенное лобби');
    const members = await R.listMembers(room.id);
    await R.closeRoom(room.id);
    track({ type: 'room_closed', roomId: room.id, payload: { reason: 'janitor' } });
    await closeLobby(api, room, members, 'Комнату давно забросили — закрыл её. /start — создать новую.').catch(
      (e) => log.error({ err: e, roomId: room.id }, 'janitor: не смог закрыть лобби'),
    );
  }
}

export function startJanitor(api: Api): void {
  const timer = setInterval(() => {
    void sweep(api).catch((e) => log.error({ err: e }, 'janitor упал'));
  }, SWEEP_MS);
  timer.unref();
}
