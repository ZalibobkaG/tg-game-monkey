/**
 * Экономика бота: внутренняя валюта, тарифы и реферальные бонусы.
 * Числа-умолчания живут здесь, а действующие значения — в таблице
 * `settings`: их правит владелец из панели без выкатки.
 */

/** Внутренняя валюта. Названа так, чтобы её нельзя было спутать с рублями. */
export const COIN = '🍌';
export const COIN_NAME = { one: 'банан', few: 'банана', many: 'бананов' } as const;

export interface Economy {
  /** какие способы оплаты показывать в магазине */
  providers: {
    /** Telegram Stars — единственный законный способ для цифровых товаров внутри бота */
    stars: boolean;
    /** ЮKassa: карты и СБП. Включать только для внешней витрины и физических товаров */
    yookassa: boolean;
    /** Crypto Pay (@CryptoBot) */
    cryptobot: boolean;
    /** оплата с личного счёта */
    wallet: boolean;
  };
  referral: {
    enabled: boolean;
    /** 🍌 пригласившему, когда приглашённый впервые что-то купил */
    inviterBonus: number;
    /** 🍌 приглашённому — приветственные */
    inviteeBonus: number;
    /** доля от покупок приглашённого, в процентах, начисляется в 🍌 */
    purchasePercent: number;
    /** сколько всего 🍌 можно получить с одного реферала; 0 — без потолка */
    perReferralCap: number;
  };
  /** сколько 🍌 даёт один рубль и одна звезда при пополнении счёта */
  rates: {
    coinsPerRub: number;
    coinsPerStar: number;
  };
}

/**
 * Умолчания. Реферальная программа выключена: её правила ещё не утверждены,
 * а код уже должен уметь и учитывать приглашения, и начислять — иначе
 * связь «кто кого привёл» за первые месяцы будет потеряна безвозвратно.
 */
export const DEFAULT_ECONOMY: Economy = {
  providers: { stars: true, yookassa: false, cryptobot: false, wallet: true },
  referral: {
    enabled: false,
    inviterBonus: 50,
    inviteeBonus: 25,
    purchasePercent: 10,
    perReferralCap: 0,
  },
  rates: { coinsPerRub: 1, coinsPerStar: 2 },
};

/** Ключ в `settings`, под которым лежит вся экономика одним объектом. */
export const ECONOMY_KEY = 'economy';

/** Русское склонение: 1 банан, 2 банана, 5 бананов. */
export function coins(n: number): string {
  const abs = Math.abs(n);
  const word =
    abs % 100 >= 11 && abs % 100 <= 14
      ? COIN_NAME.many
      : abs % 10 === 1
        ? COIN_NAME.one
        : abs % 10 >= 2 && abs % 10 <= 4
          ? COIN_NAME.few
          : COIN_NAME.many;
  return `${n} ${word}`;
}

/** Рубли из копеек — для витрины и чеков. */
export const rubles = (minor: number): string =>
  (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2)).replace('.', ',');

export const toMinor = (rub: number): number => Math.round(rub * 100);

/**
 * Сколько 🍌 капнет пригласившему с покупки. Считаем от суммы в рублёвом
 * выражении, чтобы процент не зависел от того, чем расплатились.
 */
export function referralCut(e: Economy, rubAmount: number): number {
  if (!e.referral.enabled || e.referral.purchasePercent <= 0) return 0;
  return Math.floor((rubAmount * e.referral.purchasePercent) / 100);
}
