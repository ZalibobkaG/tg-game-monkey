/*
  Клиент мини-аппа. Ванильный JS без сборки: приложение из четырёх экранов
  не окупает ни бандлер, ни фреймворк, а один статический файл всегда
  соответствует тому, что выкатили.

  Устройство простое до наглости:
    1. просим у сервера снимок состояния,
    2. рисуем его целиком,
    3. на действие — отправляем запрос и получаем новый снимок.

  Своего состояния клиент не держит вовсе: правда о комнате и партии живёт
  на сервере, потому что тех же людей одновременно обслуживает бот в чате.
  Локально хранятся только вещи, до которых серверу нет дела: открыта ли
  шторка выбора колоды и какая вкладка активна.
*/

const tg = window.Telegram && window.Telegram.WebApp;

const el = (id) => document.getElementById(id);
const app = el('app');
const tabsBar = el('tabs');

// ─── состояние клиента ─────────────────────────────────────────────────────

let state = null;      // последний снимок с сервера
let rev = null;        // его отпечаток: не менялся — DOM не трогаем
let tab = 'game';      // game | shop | me
let deckPickerOpen = false;
let qrData = null;      // картинка QR: грузится по нажатию, в снимке её нет
let busy = false;      // запрос в полёте — кнопки заперты
let pollTimer = null;
let tickTimer = null;
let mainAction = null; // что делает нижняя кнопка Telegram на этом экране

// ─── мост в Telegram ───────────────────────────────────────────────────────

function haptic(kind) {
  if (!tg || !tg.HapticFeedback) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') {
      tg.HapticFeedback.notificationOccurred(kind);
    } else {
      tg.HapticFeedback.impactOccurred(kind || 'light');
    }
  } catch (_) { /* старый клиент — обойдёмся без вибрации */ }
}

function toast(text) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function fail(text) {
  haptic('error');
  toast(text);
}

/**
 * Нижняя кнопка клиента. Она живёт вне страницы, поэтому обработчик у неё
 * один на всё приложение, а меняется только то, что он вызывает, — иначе
 * подписки копились бы с каждой перерисовкой.
 */
function setMain(params) {
  if (!tg || !tg.MainButton) return;
  if (!params) {
    mainAction = null;
    tg.MainButton.hide();
    return;
  }
  mainAction = params.onClick;
  tg.MainButton.setParams({
    text: params.text,
    is_visible: true,
    is_active: params.enabled !== false,
    color: params.color || tg.themeParams.button_color || '#2f81f7',
    text_color: params.textColor || tg.themeParams.button_text_color || '#ffffff',
  });
}

// ─── сеть ──────────────────────────────────────────────────────────────────

/**
 * Любой запрос подписан initData. Это не «токен на всякий случай»: сервер
 * по нему и узнаёт, кто пришёл, — больше личности взять неоткуда.
 */
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'tma ' + (tg ? tg.initData : ''),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Сервер ответил невпопад.' }));
  if (data.state) apply(data.state);
  if (!res.ok && !data.error) data.error = 'Ошибка ' + res.status;
  return data;
}

/** Действие пользователя: заперли кнопки, сходили на сервер, показали отказ. */
async function act(path, body) {
  if (busy) return null;
  busy = true;
  render();
  try {
    const data = await api(path, body || {});
    if (data.error) fail(data.error);
    else haptic('light');
    return data;
  } catch (e) {
    fail('Нет связи с сервером.');
    return null;
  } finally {
    busy = false;
    render();
  }
}

function apply(next) {
  // Комнаты не стало (вышли, закрыли, начали партию) — QR устарел.
  if (!next.room && qrData) qrData = null;
  state = next;
  if (next.rev !== rev) {
    rev = next.rev;
    render();
  }
}

// ─── опрос ─────────────────────────────────────────────────────────────────

/**
 * Как часто спрашивать состояние. Отсчёт 3-2-1 — единственное место, где
 * важна точность до доли секунды, всё остальное спокойно живёт на секундах.
 * Вкладка в фоне почти не опрашивается: телефон в кармане ничего не рисует.
 */
function pollDelay() {
  if (document.hidden) return 5000;
  const g = state && state.game;
  if (g) {
    if (g.phase === 'countdown') return 400;
    if (g.phase === 'voting') return 1200;
    return 1500;
  }
  return state && state.room ? 2000 : 5000;
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    await api('/api/state');
  } catch (_) { /* сеть моргнула — попробуем в следующий раз */ }
  pollTimer = setTimeout(poll, pollDelay());
}

// ─── разметка ──────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function screenHome() {
  const s = state;
  return `
    <div class="hero">
      <div class="hero__monkey">🐒</div>
      <div class="hero__title">Обезьянка</div>
      <div class="muted small">Привет, ${esc(s.me.name)}!</div>
    </div>

    <div class="card">
      <div class="h2">Новая комната</div>
      <div class="muted small" style="margin-bottom:10px">
        Соберитесь вместе, у каждого телефон. Нужно ${s.rules.minPlayers}–${s.rules.maxPlayers} человек.
      </div>
      <button class="btn btn--banana" data-act="create">🎲 Создать комнату</button>
    </div>

    <div class="card">
      <div class="h2">Войти по коду</div>
      <div class="stack">
        <input type="text" id="code" placeholder="MONKEY" maxlength="12" autocomplete="off" autocapitalize="characters" />
        <button class="btn btn--primary" data-act="join">Войти</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat__n">${s.stats.gamesPlayed}</div><div class="stat__l">партий</div></div>
      <div class="stat"><div class="stat__n">${s.stats.gamesAsMonkey}</div><div class="stat__l">был обезьянкой</div></div>
      <div class="stat"><div class="stat__n">${s.stats.wins}</div><div class="stat__l">побед</div></div>
    </div>
  `;
}

function deckPicker() {
  const s = state;
  const rows = s.decks
    .map((d) => {
      const chosen = s.room.deckId === d.id;
      const lock = d.owned ? '' : ' 🔒';
      return `
        <button class="setting" data-act="deck" data-id="${d.id}" ${d.owned ? '' : 'disabled'}>
          <span class="grow ellipsis">${esc(d.title)}${lock}</span>
          <span class="setting__v">${chosen ? '✓' : ''}</span>
        </button>`;
    })
    .join('');
  return `<div class="stack" style="margin-top:8px">${rows}</div>`;
}

function screenLobby() {
  const s = state;
  const r = s.room;

  const players = r.members
    .map(
      (m) => `
      <div class="player ${m.isMe ? 'player--me' : ''}">
        <div class="player__seat">${m.seat}</div>
        <div class="grow ellipsis">${esc(m.name)}</div>
        ${m.isAdmin ? '<div class="player__tag">ведущий</div>' : ''}
        ${m.dmOk ? '' : '<div class="player__tag">нет ЛС</div>'}
      </div>`,
    )
    .join('');

  const settings = r.isAdmin
    ? `
      <div class="card">
        <div class="h2">Настройки</div>
        <div class="stack">
          <button class="setting" data-act="deckPicker">
            <span class="grow ellipsis">🎴 Колода</span>
            <span class="setting__v">${esc(r.deckTitle || 'не выбрана')} ›</span>
          </button>
          ${deckPickerOpen ? deckPicker() : ''}
          <button class="setting" data-act="voteEvery">
            <span class="grow">🗳 Голосование</span>
            <span class="setting__v">${r.voteEvery === 1 ? 'каждый раунд' : 'раз в ' + r.voteEvery} ›</span>
          </button>
          <button class="setting" data-act="lock">
            <span class="grow">${r.locked ? '🔒 Вход закрыт' : '🔓 Вход открыт'}</span>
            <span class="setting__v">${r.locked ? 'открыть' : 'закрыть'} ›</span>
          </button>
        </div>
      </div>`
    : '';

  const startBlock = r.isAdmin
    ? `<button class="btn btn--banana" data-act="start" ${r.canStart ? '' : 'disabled'}>
         ▶️ Начать игру
       </button>
       ${r.startError ? `<div class="muted small center" style="margin-top:8px">${esc(r.startError)}</div>` : ''}`
    : `<div class="muted small center">Ждём, пока ведущий начнёт игру…</div>`;

  return `
    <div class="card">
      <div class="muted small center">код комнаты</div>
      <div class="code">${esc(r.code)}</div>
      <div class="row" style="margin-top:8px">
        <button class="btn btn--chip grow" data-act="copy">📋 Код</button>
        <button class="btn btn--chip grow" data-act="qr">${qrData ? '🙈 Скрыть' : '📷 QR'}</button>
        <button class="btn btn--chip grow" data-act="share">🔗 Позвать</button>
      </div>
      ${qrData ? `<div class="center" style="margin-top:10px"><img class="qr" src="${qrData}" alt="QR комнаты" /></div>` : ''}
    </div>

    <div class="card">
      <div class="row row--between" style="margin-bottom:8px">
        <div class="h2" style="margin:0">Игроки</div>
        <div class="muted small">${r.members.length} / ${s.rules.maxPlayers}</div>
      </div>
      <div class="players">${players}</div>
    </div>

    ${settings}

    <div class="card">${startBlock}</div>

    <button class="btn btn--danger" data-act="${r.isAdmin ? 'close' : 'leave'}">
      ${r.isAdmin ? 'Закрыть комнату' : 'Выйти из комнаты'}
    </button>
  `;
}

function cardList(g) {
  if (!g.card) {
    return `
      <div class="card center">
        <div class="big big--monkey">🐒</div>
        <div class="h2">Ты обезьянка</div>
        <div class="muted small">Списка ты не знаешь. По сигналу смотри на других и повторяй — быстро.</div>
      </div>`;
  }
  const rows = g.card
    .map((a, i) => {
      const now = g.revealedNumber === i + 1;
      return `<div class="action ${now ? 'is-now' : ''}"><div class="action__n">${i + 1}</div><div class="grow">${esc(a)}</div></div>`;
    })
    .join('');
  return `<div class="card"><div class="h2">🎴 Твоя карточка</div><div class="actions">${rows}</div></div>`;
}

function phaseBlock(g) {
  if (g.phase === 'countdown') {
    return `<div class="card"><div class="phase">
      <div class="phase__round">Раунд ${g.round} из ${g.maxRounds}</div>
      <div class="tick" id="tick">3</div>
      <div class="muted">Приготовились…</div>
    </div></div>`;
  }

  if (g.phase === 'revealed') {
    const body = g.isMonkey
      ? `<div class="big big--monkey pulse">🐒</div><div class="deal">КОПИРУЙ!</div>`
      : `<div class="big pulse">${g.revealedNumber || '—'}</div><div class="deal">ДЕЛАЙ!</div>`;
    return `<div class="card"><div class="phase">
      <div class="phase__round">Раунд ${g.round} из ${g.maxRounds}</div>
      ${body}
    </div></div>`;
  }

  if (g.phase === 'voting') return votingBlock(g);

  return `<div class="card"><div class="phase">
    <div class="phase__round">Раунд ${g.round + 1} из ${g.maxRounds}</div>
    <div class="big">🎬</div>
    <div class="muted">${g.isAdmin ? 'Все готовы? Жми «Погнали».' : 'Ждём ведущего…'}</div>
  </div></div>`;
}

function votingBlock(g) {
  const v = g.voting;
  const answered = v.answered;
  const pct = v.total ? Math.round((answered / v.total) * 100) : 0;

  if (v.myVote !== null || v.mySkipped) {
    const mine = v.candidates.find((c) => c.userId === v.myVote);
    return `<div class="card">
      <div class="h2">🗳 ${v.revote ? 'Переголосование' : 'Голосование'}</div>
      <div class="muted small" style="margin-bottom:10px">
        ${v.mySkipped ? 'Ты воздержался.' : 'Твой голос: <b>' + esc(mine ? mine.name : '—') + '</b>'}
      </div>
      <div class="progress"><div class="progress__fill" style="width:${pct}%"></div></div>
      <div class="muted small center" style="margin-top:8px">Ответили ${answered} из ${v.total}</div>
    </div>`;
  }

  const buttons = v.candidates
    .map((c) => `<button class="vote__btn" data-act="vote" data-id="${c.userId}">${esc(c.name)}</button>`)
    .join('');

  return `<div class="card">
    <div class="h2">🗳 ${v.revote ? 'Переголосование' : 'Кто обезьянка?'}</div>
    ${v.revote ? '<div class="muted small" style="margin-bottom:8px">Голоса разделились — выбираем между лидерами.</div>' : ''}
    <div class="vote">${buttons}</div>
    ${v.canSkip ? '<button class="btn btn--ghost" style="margin-top:8px" data-act="skip">⏭ Пропустить</button>' : ''}
    <div class="muted small center" style="margin-top:6px">Ответили ${answered} из ${v.total}</div>
  </div>`;
}

/**
 * Кнопки ведущего. Та же пара действий висит и на нижней кнопке Telegram —
 * дублирование намеренное: MainButton живёт вне страницы и в старых клиентах
 * может не появиться, а партия без «Погнали» останавливается совсем.
 */
function adminControls(g) {
  if (!g.isAdmin) return '';
  if (g.phase === 'countdown' || g.phase === 'voting') {
    return `<button class="btn btn--danger" data-act="end">⏹ Завершить партию</button>`;
  }
  const first = g.round === 0;
  const vote = g.nextIsVote && !first;
  return `
    <button class="btn btn--banana" data-act="${vote ? 'voting' : 'go'}">
      ${vote ? '🗳 Голосовать' : first ? '▶️ Погнали' : '▶️ Следующий раунд'}
    </button>
    <button class="btn btn--danger" data-act="end">⏹ Завершить партию</button>`;
}

function screenGame() {
  const g = state.game;
  return phaseBlock(g) + cardList(g) + adminControls(g);
}

function screenResult() {
  const r = state.result;
  if (r.peasantsWon === null) {
    return `<div class="card result">
      <div class="result__emoji">🚪</div>
      <div class="result__title">Партия отменена</div>
      <div class="muted small">${esc(r.reason || '')}</div>
    </div>`;
  }
  return `<div class="card result">
    <div class="result__emoji">${r.peasantsWon ? '🎉' : '🐒'}</div>
    <div class="result__title">${r.peasantsWon ? 'Обезьянку поймали!' : 'Обезьянка выиграла'}</div>
    <div class="muted small">${r.monkeyNames.length ? 'Ей была: ' + esc(r.monkeyNames.join(', ')) : ''}</div>
    <div class="muted small">Раундов сыграно: ${r.rounds}</div>
  </div>`;
}

function screenShop() {
  const s = state;
  const cards = s.decks
    .map((d) => {
      const pay = [];
      if (!d.owned && d.isPremium) {
        if (s.providers.stars && d.priceStars > 0) {
          pay.push(`<button class="btn btn--primary" data-act="buy" data-id="${d.id}" data-provider="stars">⭐ ${d.priceStars}</button>`);
        }
        if (s.providers.wallet && d.priceCoins > 0) {
          pay.push(`<button class="btn btn--banana" data-act="buy" data-id="${d.id}" data-provider="wallet">${s.wallet.coin} ${d.priceCoins}</button>`);
        }
        if (!pay.length) pay.push('<div class="muted small">Цена пока не назначена</div>');
      }
      return `<div class="card deck">
        <div class="deck__top">
          <div class="deck__title grow ellipsis">${esc(d.title)}</div>
          ${d.owned ? '<div class="badge badge--own">есть</div>' : '<div class="badge">🔒</div>'}
        </div>
        ${d.description ? `<div class="muted small">${esc(d.description)}</div>` : ''}
        ${pay.length ? `<div class="row">${pay.join('')}</div>` : ''}
      </div>`;
    })
    .join('');

  return `
    <div class="hero"><div class="hero__title">🛒 Магазин</div>
      <div class="muted small">На счету: ${s.wallet.balance} ${s.wallet.coin}</div>
    </div>
    ${cards}
  `;
}

function screenMe() {
  const s = state;
  const acc = s.stats.votesCast ? Math.round((s.stats.correctVotes / s.stats.votesCast) * 100) : 0;
  return `
    <div class="hero">
      <div class="hero__monkey">📊</div>
      <div class="hero__title">${esc(s.me.name)}</div>
      ${s.me.username ? `<div class="muted small">@${esc(s.me.username)}</div>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="stat__n">${s.stats.gamesPlayed}</div><div class="stat__l">партий</div></div>
      <div class="stat"><div class="stat__n">${s.stats.wins}</div><div class="stat__l">побед</div></div>
      <div class="stat"><div class="stat__n">${acc}%</div><div class="stat__l">точность голосов</div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row row--between">
        <div>Личный счёт</div>
        <div><b>${s.wallet.balance}</b> ${s.wallet.coin}</div>
      </div>
    </div>
    <div class="card">
      <div class="h2">Как играть</div>
      <div class="muted small">
        Всем приходит одинаковая карточка из ${s.rules.cardSize} действий, одному — «ты обезьянка».
        По сигналу все резко делают действие №N; обезьянка списка не знает и копирует соседей.
        Между раундами голосуем, кто из нас обезьянка.
      </div>
    </div>
    <button class="btn btn--ghost" data-act="close-app">Закрыть приложение</button>
  `;
}

// ─── сборка экрана ─────────────────────────────────────────────────────────

function currentScreen() {
  if (tab === 'shop') return screenShop();
  if (tab === 'me') return screenMe();
  if (state.game) return screenGame();
  if (state.result) return screenResult() + (state.room ? screenLobby() : screenHome());
  if (state.room) return screenLobby();
  return screenHome();
}

/** Что должна делать нижняя кнопка Telegram на текущем экране. */
function syncMainButton() {
  if (tab !== 'game' || busy) return setMain(null);

  const g = state.game;
  if (g) {
    if (!g.isAdmin || g.phase === 'countdown' || g.phase === 'voting') return setMain(null);
    const first = g.round === 0;
    return setMain({
      text: g.nextIsVote && !first ? '🗳 ГОЛОСОВАТЬ' : first ? '▶️ ПОГНАЛИ' : '▶️ СЛЕДУЮЩИЙ РАУНД',
      color: '#ffcc4d',
      textColor: '#2b2202',
      onClick: () => act(g.nextIsVote && !first ? '/api/game/voting' : '/api/game/go'),
    });
  }

  const r = state.room;
  if (r && r.isAdmin) {
    return setMain({
      text: '▶️ НАЧАТЬ ИГРУ',
      enabled: r.canStart,
      color: '#ffcc4d',
      textColor: '#2b2202',
      onClick: () => act('/api/room/start'),
    });
  }
  return setMain(null);
}

function render() {
  if (!state) return;
  const code = document.getElementById('code');
  const keep = code ? code.value : null;

  app.innerHTML = currentScreen();
  if (keep !== null) {
    const next = document.getElementById('code');
    if (next) next.value = keep;
  }

  tabsBar.hidden = false;
  for (const btn of tabsBar.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }

  for (const btn of app.querySelectorAll('button[data-act]')) {
    if (busy) btn.disabled = true;
  }

  syncMainButton();
  syncBackButton();
  syncTick();
}

/** Локальный отсчёт: сервер сообщил только момент сигнала, цифры рисуем сами. */
function syncTick() {
  clearInterval(tickTimer);
  const g = state && state.game;
  const node = document.getElementById('tick');
  if (!node || !g || !g.revealAt) return;

  const paint = () => {
    const left = Math.ceil((g.revealAt - Date.now()) / 1000);
    node.textContent = left > 0 ? String(left) : '⏳';
  };
  paint();
  tickTimer = setInterval(paint, 200);
}

function syncBackButton() {
  if (!tg || !tg.BackButton) return;
  if (tab === 'game') tg.BackButton.hide();
  else tg.BackButton.show();
}

// ─── действия ──────────────────────────────────────────────────────────────

const ACTIONS = {
  create: () => act('/api/room/create'),

  join: () => {
    const input = document.getElementById('code');
    const code = (input && input.value || '').trim();
    if (!code) return fail('Введи код комнаты.');
    return act('/api/room/join', { code });
  },

  leave: () => act('/api/room/leave'),

  close: async () => {
    const yes = await askConfirm('Закрыть комнату для всех?');
    if (yes) await act('/api/room/close');
  },

  deckPicker: () => {
    deckPickerOpen = !deckPickerOpen;
    render();
  },

  deck: (btn) => {
    deckPickerOpen = false;
    return act('/api/room/deck', { deckId: Number(btn.dataset.id) });
  },

  voteEvery: () => {
    const options = state.rules.voteEveryOptions;
    const next = options[(options.indexOf(state.room.voteEvery) + 1) % options.length];
    return act('/api/room/voteEvery', { voteEvery: next });
  },

  lock: () => act('/api/room/lock', { locked: !state.room.locked }),

  start: () => act('/api/room/start'),

  go: () => act('/api/game/go'),

  voting: () => act('/api/game/voting'),

  vote: (btn) => act('/api/game/vote', { targetId: Number(btn.dataset.id) }),

  skip: () => act('/api/game/skip'),

  end: async () => {
    const yes = await askConfirm('Завершить партию для всех?');
    if (yes) await act('/api/game/end');
  },

  /** QR для тех, кто рядом: навёл камеру — попал в комнату. */
  qr: async () => {
    if (qrData) {
      qrData = null;
      render();
      return;
    }
    const data = await act('/api/room/qr');
    if (data && data.qr) {
      qrData = data.qr;
      render();
    }
  },

  copy: async () => {
    const code = state.room.code;
    try {
      await navigator.clipboard.writeText(code);
    } catch (_) {
      // В некоторых вебвью буфера нет — показываем код, чтобы можно было выделить.
      return showAlert('Код комнаты: ' + code);
    }
    haptic('success');
    toast('Код скопирован');
  },

  share: () => {
    const link = state.room.link;
    const text = 'Го в «Обезьянку»! Код комнаты: ' + state.room.code;
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  },

  /**
   * Покупка. Звёзды мини-апп открывает не ссылкой в браузере, а нативным
   * счётом: `openInvoice` показывает окно Telegram и возвращает исход.
   * Товар при этом выдаёт бот — по апдейту `successful_payment`, — поэтому
   * после оплаты мы просто опрашиваем состояние, пока доступ не появится.
   */
  buy: async (btn) => {
    const deckId = Number(btn.dataset.id);
    const provider = btn.dataset.provider;
    const data = await act('/api/shop/buy', { deckId, provider });
    if (!data || data.error) return;

    if (data.paid) {
      haptic('success');
      toast('Колода открыта!');
      return;
    }
    if (data.invoiceUrl && tg && tg.openInvoice) {
      tg.openInvoice(data.invoiceUrl, (status) => {
        if (status === 'paid') {
          haptic('success');
          toast('Оплачено, открываю колоду…');
          // Выдача идёт через бота: несколько опросов подряд, чтобы
          // «есть» на карточке появилось само, без перезапуска.
          let tries = 0;
          const wait = setInterval(() => {
            if (++tries > 6) return clearInterval(wait);
            api('/api/state').catch(() => {});
          }, 1000);
        } else if (status === 'failed') {
          fail('Оплата не прошла.');
        }
      });
      return;
    }
    if (data.payUrl && tg && tg.openLink) tg.openLink(data.payUrl);
  },

  'close-app': () => tg && tg.close(),
};

/*
  Диалоги. Названия не `alert`/`confirm` намеренно: объявление функции на
  верхнем уровне обычного скрипта переписывает одноимённое свойство window,
  и запасной путь `window.alert(...)` внутри такой функции ушёл бы в
  бесконечную рекурсию.
*/
function askConfirm(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

function showAlert(text) {
  if (tg && tg.showAlert) tg.showAlert(text);
  else window.alert(text);
}

// ─── события ───────────────────────────────────────────────────────────────

app.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const fn = ACTIONS[btn.dataset.act];
  if (fn) fn(btn);
});

tabsBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  tab = btn.dataset.tab;
  deckPickerOpen = false;
  qrData = null;
  haptic('light');
  render();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

// ─── старт ─────────────────────────────────────────────────────────────────

function bootError(html) {
  app.innerHTML = `<div class="card center" style="margin-top:20vh">${html}</div>`;
}

async function boot() {
  if (!tg) {
    bootError('<div class="big">🐒</div><div class="h2">Открой это из Telegram</div><div class="muted small">Приложение работает только внутри клиента Telegram — оно берёт оттуда, кто ты.</div>');
    return;
  }

  tg.ready();
  tg.expand();
  if (tg.BackButton) tg.BackButton.onClick(() => { tab = 'game'; render(); });
  if (tg.MainButton) tg.MainButton.onClick(() => { if (mainAction) mainAction(); });
  // Обезьянка в тёмной теме читается ровно так же, как в светлой:
  // цвета берём из клиента, а шапку красим под фон страницы.
  if (tg.setHeaderColor) { try { tg.setHeaderColor('secondary_bg_color'); } catch (_) {} }

  // Подписи может не быть по двум разным причинам: страницу открыли не из
  // Telegram — или это разработка в обычном браузере, где сервер пускает
  // по WEBAPP_DEV_TG_ID. Отличить их отсюда нельзя, поэтому просто пробуем.
  try {
    const data = await api('/api/state');
    if (!data.ok) {
      bootError(
        tg.initData
          ? `<div class="big">😕</div><div class="h2">Не пускает</div><div class="muted small">${esc(data.error || '')}</div>`
          : '<div class="big">🔒</div><div class="h2">Открой через Telegram</div><div class="muted small">Страница берёт из клиента Telegram, кто ты. Зайди кнопкой в чате с ботом.</div>',
      );
      return;
    }
  } catch (_) {
    bootError('<div class="big">📡</div><div class="h2">Сервер не отвечает</div><div class="muted small">Попробуй открыть приложение ещё раз.</div>');
    return;
  }

  render();
  poll();
}

boot();
