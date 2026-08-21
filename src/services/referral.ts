import * as Ref from '../repo/referrals.js';
import * as W from '../repo/wallet.js';
import { getEconomy } from '../repo/settings.js';
import { referralLink } from '../config.js';
import { trackReferralAttached } from './analytics.js';
import { log } from '../lib/log.js';

/**
 * Реферальная программа.
 *
 * Правила ещё не утверждены, поэтому здесь сознательно разделены две вещи:
 * учёт (кто кого привёл — пишем всегда, с первого дня) и вознаграждение
 * (считаем только когда программа включена в настройках). Связь нельзя
 * восстановить задним числом, а бонусы — можно доначислить когда угодно.
 */

/**
 * Сколько после первого запуска ссылка ещё считается приглашением.
 * Не «навсегда»: иначе давнего пользователя, случайно открывшего чужую
 * ссылку, задним числом запишут в чьи-то рефералы.
 */
const ATTACH_WINDOW_MS = 5 * 60 * 1000;

export interface AttachOutcome {
  attached: boolean;
  /** приветственные 🍌, если программа включена и бонус назначен */
  bonus: number;
}

/**
 * Обработать переход по пригласительной ссылке. Возвращает, что показать
 * пришедшему; ошибки внутри не пробрасываются — сорванное начисление не
 * должно мешать человеку войти в бота.
 */
export async function handleInvite(inviteeId: number, code: string): Promise<AttachOutcome> {
  const res = await Ref.attach(inviteeId, code, { maxAgeMs: ATTACH_WINDOW_MS });
  if (!res.ok) return { attached: false, bonus: 0 };

  trackReferralAttached(inviteeId, res.referrerId);

  const e = await getEconomy();
  if (!e.referral.enabled || e.referral.inviteeBonus <= 0) return { attached: true, bonus: 0 };

  try {
    await W.credit({
      userId: inviteeId,
      amount: e.referral.inviteeBonus,
      reason: 'signup_bonus',
      refId: res.referrerId,
      comment: 'Пришёл по приглашению',
    });
    return { attached: true, bonus: e.referral.inviteeBonus };
  } catch (err) {
    log.error({ err, inviteeId }, 'приветственный бонус не начислен');
    return { attached: true, bonus: 0 };
  }
}

export interface InviteCard {
  link: string;
  code: string;
  invited: number;
  earned: number;
  balance: number;
  enabled: boolean;
  inviterBonus: number;
  inviteeBonus: number;
  purchasePercent: number;
}

/** Всё, что нужно нарисовать на экране «Пригласи друзей». */
export async function inviteCard(userId: number): Promise<InviteCard> {
  const [code, stats, wallet, e] = await Promise.all([
    Ref.ensureCode(userId),
    Ref.statsOf(userId),
    W.getWallet(userId),
    getEconomy(),
  ]);

  return {
    link: referralLink(code),
    code,
    invited: stats.invited,
    earned: stats.earned,
    balance: wallet.balance,
    enabled: e.referral.enabled,
    inviterBonus: e.referral.inviterBonus,
    inviteeBonus: e.referral.inviteeBonus,
    purchasePercent: e.referral.purchasePercent,
  };
}
