import type { PaymentProvider } from '../repo/payments.js';

/**
 * Общий контракт кассы. Провайдеры отличаются тем, ЧЕМ платят, а не тем,
 * как устроена выдача товара: она одна на всех и живёт в services/purchase.
 */

/** Что показать человеку, чтобы он заплатил. */
export type Checkout =
  /** внешняя касса: ведём по ссылке */
  | { kind: 'url'; url: string; externalId?: string }
  /** Telegram Stars: бот отправляет нативный счёт прямо в чат */
  | { kind: 'stars'; title: string; description: string; payload: string; amount: number }
  /** списание с личного счёта — платить некуда, всё уже произошло */
  | { kind: 'settled' };

export interface CheckoutRequest {
  orderId: string;
  title: string;
  description: string;
  /** в минорных единицах валюты провайдера */
  amountMinor: number;
  /** tg_id — нужен кассам для чека и для возврата человека в бота */
  tgId: number;
}

export interface ProviderAdapter {
  id: PaymentProvider;
  title: string;
  /** валюта, в которой этот провайдер принимает: RUB, XTR, USDT, COIN */
  currency: string;
  /** есть ли ключи. Ненастроенный провайдер нельзя включить из панели */
  configured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<Checkout>;
}

/** Провайдер отказал. Отдельный тип, чтобы не путать с нашими багами. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: PaymentProvider,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
