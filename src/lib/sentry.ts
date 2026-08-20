import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { log } from './log.js';

let enabled = false;

/** Без DSN Sentry не поднимается — ошибки остаются в логе, и это нормально для dev. */
export function initSentry(): void {
  if (!config.sentryDsn) return;
  Sentry.init({ dsn: config.sentryDsn, environment: config.mode, tracesSampleRate: 0 });
  enabled = true;
  log.info('Sentry подключён');
}

export function captureError(e: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(e, extra ? { extra } : undefined);
}

export const flushSentry = (): Promise<boolean> => (enabled ? Sentry.flush(2000) : Promise.resolve(true));
