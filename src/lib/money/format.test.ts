import { formatMoney } from './format';

describe('formatMoney', () => {
  it('formats USD cents with a dollar sign and grouping', () => {
    expect(formatMoney(123456, 'USD', 'en-US')).toBe('$1,234.56');
  });

  it('formats JPY with no decimals', () => {
    expect(formatMoney(1500, 'JPY', 'en-US')).toBe('¥1,500');
  });

  it('formats GBP with a currency symbol and two decimals', () => {
    expect(formatMoney(500, 'GBP', 'en-GB')).toBe('£5.00');
  });

  it('formats a three-decimal currency like KWD', () => {
    // ICU uses a non-breaking space (U+00A0) between the code and the amount.
    expect(formatMoney(12500, 'KWD', 'en-US')).toBe('KWD 12.500');
  });

  it('is lowercase-currency-code tolerant', () => {
    expect(formatMoney(1200, 'usd', 'en-US')).toBe('$12.00');
  });
});
