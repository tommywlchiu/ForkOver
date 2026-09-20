/**
 * Formats integer minor units for display. See SPEC.md section 6.5.
 * The only place floats are allowed: final render, never math (AGENTS.md).
 */
import { currencyExponent } from './currency';

export function formatMoney(cents: number, currency: string, locale: string): string {
  const exponent = currencyExponent(currency);
  const amount = cents / 10 ** exponent;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}
