import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Статика мини-аппа. Отдаём сами, без nginx: файлов три, а лишний слой
 * в проде — это ещё одно место, где адрес приложения может разъехаться
 * с тем, что записано в @BotFather.
 */

/** После сборки лежит в `dist/public` — путь считаем от собственного модуля. */
const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Путь из URL в путь на диске. `..` вырезаем не проверкой строки, а сверкой
 * результата с корнем: любые хитрости с кодированием отваливаются здесь.
 */
function resolveFile(pathname: string): string | null {
  let rel: string;
  try {
    // На битом проценте (`/app/%`) decodeURIComponent кидает — а здесь это
    // означало бы необработанный отказ промиса и упавший процесс.
    rel = decodeURIComponent(pathname.replace(/^\/app\/?/, '')) || 'index.html';
  } catch {
    return null;
  }
  const full = resolve(join(ROOT, normalize(rel)));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

export async function handleStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  const pathname = url.split('?')[0] ?? '';
  if (pathname !== '/app' && !pathname.startsWith('/app/')) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }

  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(403).end();
    return true;
  }

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('не файл');
    size = info.size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет такой страницы');
    return true;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    // Мини-апп живёт внутри Telegram и обновляется вместе с ботом:
    // кеш выключен намеренно, иначе после выкатки у половины игроков
    // остаётся вчерашний интерфейс.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
