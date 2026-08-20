import { Composer, GrammyError } from 'grammy';
import type { BotContext } from '../types.js';
import * as F from '../repo/feedback.js';
import * as UI from '../ui/feedback.js';
import * as R from '../repo/rooms.js';
import { notifyPlan, roleOf } from '../repo/admins.js';
import { playerStats } from '../repo/stats.js';
import { displayName } from '../repo/users.js';
import * as pending from '../lib/pending.js';
import { track, trackAdminAction } from '../services/analytics.js';
import { log } from '../lib/log.js';

export const feedbackHandler = new Composer<BotContext>();

const MIN_LEN = 10;
const MAX_LEN = 2000;
/** Потолок против явного флуда; на обычное использование не влияет. */
const RATE_LIMIT = 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const KINDS: F.FeedbackKind[] = ['idea', 'bug', 'deck', 'other'];
const isKind = (s: string): s is F.FeedbackKind => (KINDS as string[]).includes(s);

// ─── пользователь пишет ───────────────────────────────────────────────────

async function openPicker(ctx: BotContext): Promise<void> {
  const { text, keyboard } = UI.renderKindPicker();
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

feedbackHandler.command('feedback', (ctx) => openPicker(ctx));

feedbackHandler.callbackQuery('fb:new', async (ctx) => {
  await ctx.answerCallbackQuery();
  await openPicker(ctx);
});

feedbackHandler.callbackQuery('fb:cancel', async (ctx) => {
  pending.clear(ctx.user.tgId);
  await ctx.answerCallbackQuery({ text: 'Отменил.' });
  await ctx.deleteMessage().catch(() => {});
});

feedbackHandler.callbackQuery(/^fb:kind:(\w+)$/, async (ctx) => {
  const kind = ctx.match![1]!;
  if (!isKind(kind)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'feedback', kind);
  // force_reply гарантирует, что ответ придёт с reply_to_message — по нему
  // мы восстановим тему, даже если состояние в памяти к тому моменту исчезнет
  await ctx.reply(UI.renderPrompt(kind), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Текст обращения' },
  });
  await ctx.deleteMessage().catch(() => {});
});

async function submitFeedback(ctx: BotContext, kind: F.FeedbackKind, text: string): Promise<void> {
  if (text.length < MIN_LEN) {
    pending.expect(ctx.user.tgId, 'feedback', kind);
    await ctx.reply(UI.renderTooShort(MIN_LEN), { parse_mode: 'HTML' });
    return;
  }
  if (text.length > MAX_LEN) {
    pending.expect(ctx.user.tgId, 'feedback', kind);
    await ctx.reply(UI.renderTooLong(MAX_LEN), { parse_mode: 'HTML' });
    return;
  }

  const recent = await F.countRecentByUser(ctx.user.id, new Date(Date.now() - RATE_WINDOW_MS));
  if (recent >= RATE_LIMIT) {
    await ctx.reply(UI.renderTooOften(RATE_LIMIT), { parse_mode: 'HTML' });
    return;
  }

  const room = await R.activeRoomOf(ctx.user.id);
  const fb = await F.createFeedback({ userId: ctx.user.id, roomId: room?.id ?? null, kind, text });

  await ctx.reply(UI.renderSent(fb.id), { parse_mode: 'HTML' });
  track({ type: 'feedback_sent', userId: ctx.user.id, roomId: room?.id ?? null, payload: { kind } });

  await notifyAdmins(ctx, fb.id).catch((e) => log.error({ err: e, feedbackId: fb.id }, 'уведомление админам'));
}

/** Про сломанный ADMIN_CHAT_ID достаточно сказать один раз за запуск. */
let warnedAboutChat = false;

/**
 * Уведомление админам: сначала служебный чат, при неудаче — каждому в личку.
 * Обращение уже лежит в базе и видно в панели, так что сбой доставки
 * ничего не теряет — но и молчать о нём нельзя.
 */
async function notifyAdmins(ctx: BotContext, feedbackId: number): Promise<void> {
  const fb = await F.getFeedback(feedbackId);
  if (!fb) return;

  const stats = await playerStats(fb.userId);
  const room = fb.roomId ? await R.getRoom(fb.roomId) : undefined;
  const { text, keyboard } = UI.renderAdminCard({
    fb,
    gamesPlayed: stats.gamesPlayed,
    roomCode: room?.code ?? null,
  });

  const send = (chatId: number): Promise<boolean> =>
    ctx.api
      .sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      .then(() => true)
      .catch((e: unknown) => {
        const reason = e instanceof GrammyError ? e.description : String(e);
        log.warn({ feedbackId: fb.id, chatId, reason }, 'обращение не доставлено');
        return false;
      });

  const plan = await notifyPlan();

  if (plan.chat !== null && (await send(plan.chat))) return;

  if (plan.chat !== null && !warnedAboutChat) {
    warnedAboutChat = true;
    log.warn(
      { adminChatId: plan.chat },
      'ADMIN_CHAT_ID недоступен: проверь, что бот добавлен в чат и id верный (в чате: /chatid). ' +
        'Пока шлю обращения админам в личку',
    );
  }

  if (!plan.dms.length) {
    log.warn({ feedbackId: fb.id }, 'обращение некому показать: ADMIN_IDS пуст и таблица admins тоже');
    return;
  }
  for (const dm of plan.dms) await send(dm);
}

// ─── админ разбирает ──────────────────────────────────────────────────────

/** Молча игнорируем не-админов: панель не должна выдавать себя. */
async function requireAdmin(ctx: BotContext): Promise<boolean> {
  const role = await roleOf(ctx.user);
  if (!role) {
    await ctx.answerCallbackQuery().catch(() => {});
    return false;
  }
  return true;
}

async function showCard(ctx: BotContext, id: number, edit: boolean): Promise<void> {
  const fb = await F.getFeedback(id);
  if (!fb) {
    await ctx.answerCallbackQuery({ text: 'Обращение не найдено.', show_alert: true });
    return;
  }
  const stats = await playerStats(fb.userId);
  const room = fb.roomId ? await R.getRoom(fb.roomId) : undefined;
  const { text, keyboard } = UI.renderAdminCard({
    fb,
    gamesPlayed: stats.gamesPlayed,
    roomCode: room?.code ?? null,
  });
  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

feedbackHandler.callbackQuery(/^fbadm:open:(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await ctx.answerCallbackQuery();
  await F.setStatus(Number(ctx.match![1]), 'read');
  await showCard(ctx, Number(ctx.match![1]), false);
});

feedbackHandler.callbackQuery(/^fbadm:(read|spam|arch):(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const action = ctx.match![1] as 'read' | 'spam' | 'arch';
  const id = Number(ctx.match![2]);
  const status = action === 'read' ? 'read' : action === 'spam' ? 'spam' : 'archived';
  await F.setStatus(id, status);
  trackAdminAction(ctx.user.id, `обращение → ${status}`, null, { feedbackId: id });
  await ctx.answerCallbackQuery({ text: `Статус: ${status}` });
  await showCard(ctx, id, true);
});

feedbackHandler.callbackQuery(/^fbadm:reply:(\d+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const id = Number(ctx.match![1]);
  await ctx.answerCallbackQuery();
  pending.expect(ctx.user.tgId, 'feedback_reply', String(id));
  track({ type: 'feedback_reply_started', userId: ctx.user.id, payload: { feedbackId: id } });
  await ctx.reply(UI.renderReplyPrompt(id), {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'Текст ответа' },
  });
});

async function sendReply(ctx: BotContext, id: number, reply: string): Promise<void> {
  const fb = await F.getFeedback(id);
  if (!fb) {
    await ctx.reply('Обращение не найдено.');
    return;
  }
  await F.saveReply(id, ctx.user.id, reply);
  track({ type: 'feedback_replied', userId: ctx.user.id, payload: { feedbackId: id } });
  trackAdminAction(ctx.user.id, 'ответил на обращение', fb.userId, { feedbackId: id });
  log.info({ feedbackId: id, to: fb.user.tgId }, 'ответ на обращение отправлен');
  await ctx.api
    .sendMessage(fb.user.tgId, UI.renderUserReply(fb.kind, reply), { parse_mode: 'HTML' })
    .then(() => ctx.reply(`✅ Ответ отправлен ${displayName(fb.user)}.`))
    .catch(async () => {
      await ctx.reply('⚠️ Ответ сохранён, но доставить не удалось — человек заблокировал бота.');
    });
}

// ─── текстовый ввод ───────────────────────────────────────────────────────

/**
 * Свой обработчик текста: регистрируется раньше `startHandler`, забирает
 * только свои виды ожидания, всё остальное пропускает дальше по цепочке.
 */
feedbackHandler.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();

  // 1) Нативный ответ на наше приглашение. Весь нужный контекст лежит
  //    в самом сообщении, поэтому этот путь переживает и долгую паузу,
  //    и перезапуск процесса — в отличие от Map в памяти.
  const source = ctx.message.reply_to_message;
  const fromBot = Boolean(source && source.from?.id === ctx.me.id);
  const sourceText = source && 'text' in source ? (source.text ?? '') : '';

  if (fromBot && sourceText) {
    // реплай на карточку обращения ИЛИ на приглашение ответить — годится и то и то
    const ref = UI.FEEDBACK_REF_RE.exec(sourceText);
    if (ref) {
      if (!(await roleOf(ctx.user))) return next();
      pending.clear(ctx.user.tgId);
      return sendReply(ctx, Number(ref[1]), text);
    }
    const askedKind = UI.kindFromPrompt(sourceText);
    if (askedKind) {
      pending.clear(ctx.user.tgId);
      return submitFeedback(ctx, askedKind, text);
    }
  }

  // 2) Обычный путь внутри одной сессии — только в личке: в общем админ-чате
  //    состояние по автору перебивалось бы, если пишут двое сразу.
  if (ctx.chat.type !== 'private') return next();

  const waiting = pending.peek(ctx.user.tgId);
  if (!waiting) {
    // Админ явно отвечает на наше сообщение, но привязать не к чему —
    // молчать тут нельзя, иначе выглядит как «бот сломался».
    if (fromBot && (await roleOf(ctx.user))) {
      await ctx.reply(
        'Не понял, к какому обращению это относится.\n' +
          'Открой /admin → «Обращения», нажми «✍️ Ответить» и ответь на приглашение.',
      );
      return;
    }
    return next();
  }

  if (waiting.kind === 'feedback') {
    pending.clear(ctx.user.tgId);
    const kind = waiting.payload && isKind(waiting.payload) ? waiting.payload : 'other';
    return submitFeedback(ctx, kind, text);
  }

  if (waiting.kind === 'feedback_reply') {
    pending.clear(ctx.user.tgId);
    if (!(await roleOf(ctx.user))) return;
    return sendReply(ctx, Number(waiting.payload), text);
  }

  return next();
});
