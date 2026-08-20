import { createRequire } from 'node:module';
import pino from 'pino';
import { config } from '../config.js';

/**
 * Структурный лог. В dev — читаемый вывод в терминал, в проде — JSON в stdout:
 * его подхватывает docker/systemd, и по нему можно искать (`roomId`, `gameId`).
 *
 * Раньше всё уходило в `console.*`: закрыл терминал — истории нет,
 * а найти в потоке строку по конкретной комнате было нечем.
 */
/**
 * Читаемый вывод только в dev и только если pino-pretty реально установлен:
 * он лежит в devDependencies, а прод собирается без них.
 */
function prettyTransport(): { transport: pino.TransportSingleOptions } | undefined {
  if (config.mode !== 'polling') return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return {
    transport: {
      target: 'pino-pretty',
      // SYS: — местное время, иначе лог в UTC, а панель в локали: сопоставлять больно
      options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    },
  };
}

export const log = pino({
  level: config.logLevel,
  base: undefined, // pid/hostname нам не нужны — процесс один
  ...(prettyTransport() ?? {}),
});

/** Логгер, привязанный к комнате: `roomId` и код попадают в каждую строку. */
export const roomLog = (roomId: number, code?: string): pino.Logger =>
  log.child(code ? { roomId, code } : { roomId });

export const gameLog = (gameId: number, roomId: number): pino.Logger => log.child({ gameId, roomId });
