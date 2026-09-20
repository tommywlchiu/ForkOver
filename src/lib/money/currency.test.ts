import { currencyExponent } from './currency';

describe('currencyExponent', () => {
  it('returns 2 for USD', () => {
    expect(currencyExponent('USD')).toBe(2);
  });

  it('returns 0 for JPY', () => {
    expect(currencyExponent('JPY')).toBe(0);
  });

  it('returns 3 for KWD', () => {
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('returns 2 for EUR and GBP', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('GBP')).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
  });

  it('falls back to a sane default for an unknown code', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
  });
});
