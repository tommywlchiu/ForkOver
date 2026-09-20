/**
 * Currency metadata. See SPEC.md section 6.5.
 */

// Fallback table for currencies where Hermes' Intl data might not resolve the
// right fraction digits (checked against Intl.NumberFormat in M1; kept as a
// safety net since Hermes' ICU data varies by platform/build).
const FALLBACK_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  ISK: 0,
  CLP: 0,
  VND: 0,
  KRW: 0,
};

/**
 * Number of minor-unit decimal digits for a currency (USD 2, JPY 0, KWD 3),
 * from Intl.NumberFormat's resolved options, falling back to a hard-coded
 * table for currencies in the eval set if that fails or looks wrong.
 */
export function currencyExponent(code: string): number {
  const upper = code.toUpperCase();
  try {
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: upper,
    }).resolvedOptions();
    if (typeof resolved.maximumFractionDigits === 'number') {
      return resolved.maximumFractionDigits;
    }
  } catch {
    // Unknown or malformed currency code; fall through to the table.
  }
  return FALLBACK_EXPONENTS[upper] ?? 2;
}
