import { starsProvider } from './stars.js';
import { yookassaProvider } from './yookassa.js';
import { cryptoBotProvider } from './cryptobot.js';
import type { ProviderAdapter } from './types.js';
import type { PaymentProvider } from '../repo/payments.js';
import type { Economy } from '../domain/economy.js';

export { ProviderError } from './types.js';
export type { Checkout, CheckoutRequest, ProviderAdapter } from './types.js';
export { starsProvider } from './stars.js';

const ADAPTERS: Partial<Record<PaymentProvider, ProviderAdapter>> = {
  stars: starsProvider,
  yookassa: yookassaProvider,
  cryptobot: cryptoBotProvider,
};

export function adapter(id: PaymentProvider): ProviderAdapter | undefined {
  return ADAPTERS[id];
}

/**
 * Какие кассы доступны сейчас. Провайдер показывается, только если он
 * И включён в настройках, И настроен ключами: галочка в панели без ключей
 * не должна приводить человека к счёту, который невозможно выставить.
 */
export function availableProviders(e: Economy): ProviderAdapter[] {
  return (Object.keys(ADAPTERS) as PaymentProvider[])
    .filter((id) => id in e.providers && e.providers[id as keyof Economy['providers']])
    .map((id) => ADAPTERS[id])
    .filter((a): a is ProviderAdapter => Boolean(a) && a!.configured());
}

/** Настроен ли провайдер — панель этим отличает «выключен» от «нет ключей». */
export function isConfigured(id: PaymentProvider): boolean {
  return ADAPTERS[id]?.configured() ?? false;
}
