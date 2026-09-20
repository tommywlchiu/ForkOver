/**
 * Parses user-typed money input into integer minor units. See SPEC.md section 6.5.
 */
import { currencyExponent } from './currency';

/**
 * Accepts digits with up to the currency's exponent of decimals, an optional
 * leading currency symbol, and optional grouping separators ("12", "12.5",
 * "$12.50", "1,234.56", "1500" for JPY). Rejects extra decimals, negatives,
 * and non-numbers. Returns cents, or null when the input can't be parsed.
 */
export function parseMoneyInput(input: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const trimmed = input.trim();
  if (trimmed === '') {
    return null;
  }

  // Strip a single leading currency symbol (anything before the first digit
  // or minus sign), e.g. "$12.50" -> "12.50". A minus sign is left in place
  // so it gets rejected below rather than silently stripped.
  const withoutSymbol = trimmed.replace(/^[^\d-]+/, '');
  if (withoutSymbol === '' || withoutSymbol.includes('-')) {
    return null;
  }
  if (/[^\d,.]/.test(withoutSymbol)) {
    return null;
  }

  const withoutGrouping = withoutSymbol.replace(/,/g, '');
  const pattern = exponent > 0 ? new RegExp(`^\\d+(\\.\\d{1,${exponent}})?$`) : /^\d+$/;
  if (!pattern.test(withoutGrouping)) {
    return null;
  }

  const [wholePart, fracPart = ''] = withoutGrouping.split('.');
  const cents = Number(wholePart) * 10 ** exponent + Number(fracPart.padEnd(exponent, '0') || '0');
  return Number.isSafeInteger(cents) ? cents : null;
}
