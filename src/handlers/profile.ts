import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types.js';
import { playerStats } from '../repo/stats.js';
import { displayName, forgetUser } from '../repo/users.js';
import { statsOf } from '../repo/referrals.js';
import { balanceOf } from '../repo/wallet.js';
import { renderPlayerStats } from '../ui/admin.js';
import { PRIVACY_TEXT } from '../ui/texts.js';

export const profileHandler = new Composer<BotContext>();

async function showStats(ctx: BotContext): Promise<void> {
  const [s, referrals, balance] = await Promise.all([
    playerStats(ctx.user.id),
    statsOf(ctx.user.id),
    balanceOf(ctx.user.id),
  ]);

  await ctx.reply(
    renderPlayerStats({ name: displayName(ctx.user), ...s, referrals: referrals.invited, balance }),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🎁 Пригласить друзей', 'shop:invite')
        .row()
        .text('🛒 Магазин', 'shop:home'),
    },
  );
}

profileHandler.command('stats', (ctx) => showStats(ctx));

profileHandler.callbackQuery('menu:stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showStats(ctx);
});

profileHandler.command('privacy', (ctx) => ctx.reply(PRIVACY_TEXT, { parse_mode: 'HTML' }));

profileHandler.command('forget_me', async (ctx) => {
  await ctx.reply(
    [
      '🗑 <b>Удаление данных</b>',
      '',
      'Обезличу твою запись: сотру имя и юзернейм, отвяжу события,',
      'вычищу тексты обращений. Игровая статистика останется,',
      'но перестанет быть привязанной к тебе.',
      '',
      'Отменить будет нельзя.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🗑 Да, удалить', 'me:forget')
        .row()
        .text('← Отмена', 'me:keep'),
    },
  );
});

profileHandler.callbackQuery('me:keep', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Отменил.' });
  await ctx.deleteMessage().catch(() => {});
});

profileHandler.callbackQuery('me:forget', async (ctx) => {
  await ctx.answerCallbackQuery();
  await forgetUser(ctx.user);
  await ctx
    .editMessageText('🗑 Готово. Данные обезличены.\n\nЕсли снова напишешь боту — заведём новую запись.')
    .catch(() => {});
});
