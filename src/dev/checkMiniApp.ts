/**
 * Проверка мини-аппа целиком: статика, доступ к API и полная партия,
 * сыгранная одними только HTTP-запросами.
 *
 * Смысл в последнем. Мини-апп — второй клиент к той же игре, и «работает»
 * для него значит не «страница открылась», а «трое зашли, раздались,
 * дождались сигнала и поймали обезьянку», причём никто не увидел лишнего:
 * ни чужой роли, ни номера действия до сигнала.
 *
 * Бьём по настоящим ручкам через настоящий HTTP-сервер, подменяя только
 * Telegram: партия по-прежнему шлёт карточки в личку, а личку в проверке
 * заменяет заглушка.
 *
 *     npm run check:miniapp
 */
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Api } from 'grammy';
import { db, sql as pg } from '../db/index.js';
import { rooms, roomMembers, users } from '../db/schema.js';
import { handleApi } from '../webapp/api.js';
import { handleStatic } from '../webapp/static.js';
import { config } from '../config.js';

let failed = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
  if (!cond) failed++;
};

/** Три подставных игрока. Первый — ведущий. */
const TG = [910000101, 910000102, 910000103];

/** Заглушка Telegram: партия шлёт карточку и сигнал в личку, ответы нам не важны. */
const fakeApi = {
  sendMessage: () => Promise.resolve({ message_id: Math.floor(Math.random() * 1e6) }),
  editMessageText: () => Promise.resolve({}),
  deleteMessage: () => Promise.resolve(true),
} as unknown as Api;

/** Собирает initData ровно так, как это делает Telegram. */
function sign(tgId: number): string {
  // Набор полей — как у живого клиента, вместе с `signature`: на урезанном
  // проверка прошла бы и с неверной сборкой data-check-string.
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1234567890123456789',
    chat_type: 'private',
    signature: 'Ck9Xz1Q0v_KpxT2mB8nJ4rY6sL0aD3fW',
    user: JSON.stringify({ id: tgId, first_name: 'Игрок' + tgId, username: 'p' + tgId }),
  };
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.tgId, TG));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  await db.delete(rooms).where(inArray(rooms.adminUserId, ids));
  await db.delete(roomMembers).where(inArray(roomMembers.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await cleanup();

  const server = createServer((req, res) => {
    void (async () => {
      if (await handleApi(fakeApi, req, res)) return;
      if (await handleStatic(req, res)) return;
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const heads = TG.map((id) => ({ authorization: 'tma ' + sign(id), 'content-type': 'application/json' }));

  const call = async (who: number, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: heads[who]!,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  // ── 1. Статика ──────────────────────────────────────────────────────────
  const page = await fetch(`${base}/app`);
  const html = await page.text();
  ok('GET /app отдаёт страницу', page.status === 200 && html.includes('telegram-web-app.js'), page.status);

  const css = await fetch(`${base}/app/styles.css`);
  ok('CSS отдаётся с нужным типом', css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'));

  // Классический обход: `..` в пути. Проверяем сверкой с корнем, а не строкой.
  const escape = await fetch(`${base}/app/../../package.json`, { redirect: 'manual' });
  ok('выход за корень статики не проходит', escape.status !== 200, escape.status);

  // ── 2. Доступ к API ─────────────────────────────────────────────────────
  const anon = await fetch(`${base}/api/state`);
  ok('без подписи API отвечает 401', anon.status === 401, anon.status);

  const tampered = await fetch(`${base}/api/state`, {
    headers: { authorization: heads[0]!.authorization + '&is_admin=1' },
  });
  ok('подделанная подпись отвергается', tampered.status === 401, tampered.status);

  const unknown = await fetch(`${base}/api/nope`, { method: 'POST', headers: heads[0]!, body: '{}' });
  ok('неизвестная ручка — 404', unknown.status === 404, unknown.status);

  const first = await call(0, '/api/state');
  ok('состояние приходит', first.ok === true && first.state.me.tgId === TG[0], first);
  ok('комнаты пока нет', first.state.room === null, first.state.room);
  ok('колоды в снимке есть', Array.isArray(first.state.decks) && first.state.decks.length > 0);

  // ── 3. Сбор комнаты ─────────────────────────────────────────────────────
  const created = await call(0, '/api/room/create', {});
  const code = created.state.room.code as string;
  ok('комната создана', Boolean(code), created.error);

  for (const who of [1, 2]) {
    const joined = await call(who, '/api/room/join', { code });
    ok(`игрок ${who + 1} вошёл`, joined.ok === true && joined.state.room?.code === code, joined.error);
  }

  const nope = await call(1, '/api/room/join', { code: 'ZZZZZZ' });
  ok('вход по несуществующему коду отклоняется', nope.ok === false && Boolean(nope.error), nope);

  const beforeStart = await call(0, '/api/state');
  ok('в комнате трое', beforeStart.state.room.members.length === 3, beforeStart.state.room.members.length);
  ok('можно начинать', beforeStart.state.room.canStart === true, beforeStart.state.room.startError);

  // Гость начать не может — это единственная защита от «нажал не тот».
  const guestStart = await call(1, '/api/room/start', {});
  ok('гость не запускает игру', guestStart.ok === false, guestStart);

  // ── 4. Раздача ──────────────────────────────────────────────────────────
  const started = await call(0, '/api/room/start', {});
  ok('партия началась', started.ok === true && Boolean(started.state.game), started.error);

  const views = await Promise.all([0, 1, 2].map((w) => call(w, '/api/state')));
  const monkeys = views.filter((v) => v.state.game.isMonkey);
  ok('обезьянка ровно одна', monkeys.length === 1, monkeys.length);
  ok('у обезьянки нет карточки', monkeys[0].state.game.card === null);

  const peasants = views.filter((v) => !v.state.game.isMonkey);
  ok('мирные видят 10 действий', peasants.every((v) => v.state.game.card?.length === 10));
  ok('до сигнала номера нет', views.every((v) => v.state.game.revealedNumber === null));
  ok('фаза — ожидание', views[0].state.game.phase === 'waiting', views[0].state.game.phase);

  // ── 5. Раунд ────────────────────────────────────────────────────────────
  const go = await call(0, '/api/game/go', {});
  ok('раунд запущен', go.ok === true, go.error);

  const during = await call(1, '/api/state');
  ok('идёт отсчёт', during.state.game.phase === 'countdown', during.state.game.phase);
  ok('момент сигнала известен клиенту', Number(during.state.game.revealAt) > Date.now(), during.state.game.revealAt);

  await sleep(4000);
  const after = await Promise.all([0, 1, 2].map((w) => call(w, '/api/state')));
  ok('сигнал прошёл', after.every((v) => v.state.game.phase === 'revealed'), after[0].state.game.phase);

  const peasantView = after.find((v) => !v.state.game.isMonkey);
  const monkeyView = after.find((v) => v.state.game.isMonkey);
  ok('мирному пришёл номер', Number(peasantView.state.game.revealedNumber) >= 1, peasantView.state.game.revealedNumber);
  ok('обезьянке номер не пришёл', monkeyView.state.game.revealedNumber === null);
  ok('дальше — голосование', after[0].state.game.nextIsVote === true);

  // ── 6. Голосование ──────────────────────────────────────────────────────
  const vote = await call(0, '/api/game/voting', {});
  ok('голосование открыто', vote.ok === true && vote.state.game.phase === 'voting', vote.error);

  const monkeyIdx = after.findIndex((v) => v.state.game.isMonkey);
  const monkeyUserId = after[monkeyIdx].state.game.players.find((p: any) => p.isMe).userId;

  const selfVote = await call(monkeyIdx, '/api/game/vote', { targetId: monkeyUserId });
  ok('за себя голосовать нельзя', selfVote.ok === false, selfVote.error);

  // Мирные дружно указывают на обезьянку, она воздерживается.
  for (const who of [0, 1, 2]) {
    if (who === monkeyIdx) continue;
    const v = await call(who, '/api/game/vote', { targetId: monkeyUserId });
    ok(`голос игрока ${who + 1} принят`, v.ok === true, v.error);
  }
  const skip = await call(monkeyIdx, '/api/game/skip', {});
  ok('обезьянка воздержалась', skip.ok === true, skip.error);

  await sleep(500);
  const final = await call(0, '/api/state');
  ok('партия закончилась', final.state.game === null, final.state.game?.phase);
  ok('итог показан', Boolean(final.state.result), final.state.result);
  ok('мирные победили', final.state.result?.peasantsWon === true, final.state.result);
  ok('комната вернулась в лобби', final.state.room?.state === 'lobby', final.state.room?.state);


  // Выход из комнаты закрывает круг: состояние снова пустое.
  const left = await call(0, '/api/room/leave', {});
  ok('выход из комнаты работает', left.ok === true && left.state.room === null, left);

  server.close();
  await cleanup();
  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки прошли');
  await pg.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await pg.end();
  process.exit(1);
});
