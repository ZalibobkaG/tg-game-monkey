import { config } from '../config.js';
import type { Checkout, CheckoutRequest, ProviderAdapter } from './types.js';

/**
 * Telegram Stars — единственный способ оплаты цифровых товаров внутри бота,
 * который разрешают правила Telegram (Bot Developers ToS, п. 6.2): App Store
 * и Google Play требуют, чтобы цифровой контент в приложении продавался их
 * средствами, поэтому сторонние кассы для колод здесь вне закона.
 *
 * Технически всё просто: счёт в валюте XTR, `provider_token` пустой,
 * в `prices` ровно один элемент, сумма — целые звёзды, а не копейки.
 */

/** Счёт в звёздах не может состоять из нескольких строк — это ограничение Bot API. */
export const STARS_CURRENCY = 'XTR';

/** Telegram не принимает счета дешевле одной звезды и дороже этого потолка. */
export const MIN_STARS = 1;
export const MAX_STARS = 100_000;

export const starsProvider: ProviderAdapter = {
  id: 'stars',
  title: 'Telegram Stars',
  currency: STARS_CURRENCY,

  // Звёздам не нужны ключи: касса — сам Telegram, токена бота достаточно.
  configured: () => Boolean(config.botToken),

  createCheckout(req: CheckoutRequest): Promise<Checkout> {
    const amount = Math.round(req.amountMinor);
    if (amount < MIN_STARS || amount > MAX_STARS) {
      throw new RangeError(`цена в звёздах вне допустимого диапазона: ${amount}`);
    }
    return Promise.resolve({
      kind: 'stars',
      // Telegram режет заголовок на 32 символах, а описание на 255 —
      // подрезаем сами, иначе счёт просто не отправится.
      title: req.title.slice(0, 32),
      description: req.description.slice(0, 255),
      payload: req.orderId,
      amount,
    });
  },
};
