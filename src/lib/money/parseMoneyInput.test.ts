import { parseMoneyInput } from './parseMoneyInput';

describe('parseMoneyInput', () => {
  it('parses a whole-dollar amount', () => {
    expect(parseMoneyInput('12', 'USD')).toBe(1200);
  });

  it('parses a decimal amount', () => {
    expect(parseMoneyInput('12.5', 'USD')).toBe(1250);
  });

  it('parses a leading dollar sign', () => {
    expect(parseMoneyInput('$12.50', 'USD')).toBe(1250);
  });

  it('parses grouped thousands', () => {
    expect(parseMoneyInput('1,234.56', 'USD')).toBe(123456);
  });

  it('parses whole-unit JPY with no decimal point', () => {
    expect(parseMoneyInput('1500', 'JPY')).toBe(1500);
  });

  it('parses a three-decimal KWD amount', () => {
    expect(parseMoneyInput('12.500', 'KWD')).toBe(12500);
  });

  it('rejects more decimals than the currency allows', () => {
    expect(parseMoneyInput('12.555', 'USD')).toBeNull();
  });

  it('rejects a decimal point on a zero-exponent currency', () => {
    expect(parseMoneyInput('12.5', 'JPY')).toBeNull();
  });

  it('rejects negative amounts', () => {
    expect(parseMoneyInput('-5', 'USD')).toBeNull();
    expect(parseMoneyInput('-$5', 'USD')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseMoneyInput('abc', 'USD')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseMoneyInput('', 'USD')).toBeNull();
    expect(parseMoneyInput('   ', 'USD')).toBeNull();
  });

  it('rejects a bare symbol with no digits', () => {
    expect(parseMoneyInput('$', 'USD')).toBeNull();
  });
});
