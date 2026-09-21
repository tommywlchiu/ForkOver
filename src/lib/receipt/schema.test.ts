import { notAReceipt, sampleReceipt } from './fixtures';
import { RECEIPT_JSON_SCHEMA, ISO_4217_CODES, validateLineItem, validateReceipt } from './schema';

const invalid = (value: unknown) => {
  const result = validateReceipt(value);
  if (result.ok) throw new Error('expected validation to fail');
  return result;
};

describe('RECEIPT_JSON_SCHEMA', () => {
  it('lists every property as required and forbids extras on every object', () => {
    const visit = (schema: any) => {
      if (schema?.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(visit);
      }
      if (schema?.items) visit(schema.items);
      schema?.anyOf?.forEach(visit);
    };
    visit(RECEIPT_JSON_SCHEMA);
  });

  it('describes exactly the fields of ParsedReceipt', () => {
    expect([...RECEIPT_JSON_SCHEMA.required].sort()).toEqual(Object.keys(sampleReceipt).sort());
  });

  it('uses no numeric constraints, which structured outputs do not support', () => {
    expect(JSON.stringify(RECEIPT_JSON_SCHEMA)).not.toMatch(/minimum|maximum|minLength|maxLength|multipleOf/);
  });
});

describe('validateReceipt', () => {
  it('accepts a well-formed receipt and returns it unchanged', () => {
    expect(validateReceipt(sampleReceipt)).toEqual({ ok: true, receipt: sampleReceipt });
  });

  it('accepts a non-receipt with empty arrays and zeros', () => {
    expect(validateReceipt(notAReceipt)).toEqual({ ok: true, receipt: notAReceipt });
  });

  it('accepts every tip source and null optional amounts', () => {
    for (const tipSource of ['printed', 'handwritten', 'autoGratuity', 'mixed', null] as const) {
      expect(validateReceipt({ ...sampleReceipt, tipSource }).ok).toBe(true);
    }
    const bare = { ...sampleReceipt, printedTipCents: null, printedSubtotalCents: null, printedTotalCents: null };
    expect(validateReceipt(bare).ok).toBe(true);
  });

  it('normalizes the currency code to upper case', () => {
    const result = validateReceipt({ ...sampleReceipt, currency: ' jpy ' });
    expect(result).toMatchObject({ ok: true, receipt: { currency: 'JPY' } });
  });

  it('drops keys that are not part of the schema', () => {
    const result = validateReceipt({ ...sampleReceipt, surprise: 1 });
    expect(result).toEqual({ ok: true, receipt: sampleReceipt });
  });

  it('returns INVALID_OUTPUT for values that are not objects', () => {
    for (const value of [null, undefined, 'receipt', 42, [], true]) {
      expect(invalid(value).code).toBe('INVALID_OUTPUT');
    }
  });

  it('rejects an unknown or malformed currency on a receipt', () => {
    for (const currency of ['', 'USDX', 'ZZZ', '$', 'dollars']) {
      const { errors } = invalid({ ...sampleReceipt, currency });
      expect(errors.join()).toContain('currency');
    }
    expect(invalid({ ...sampleReceipt, currency: 5 }).errors.join()).toContain('currency');
  });

  it('rejects negative, fractional, non-numeric, and unsafe amounts', () => {
    for (const bad of [-1, 1.5, '12', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(invalid({ ...sampleReceipt, taxCents: bad }).errors.join()).toContain('taxCents');
      expect(invalid({ ...sampleReceipt, discountCents: bad }).errors.join()).toContain('discountCents');
    }
    for (const bad of [-1, 1.5, '12', NaN]) {
      expect(invalid({ ...sampleReceipt, printedTotalCents: bad }).errors.join()).toContain('printedTotalCents');
      expect(invalid({ ...sampleReceipt, printedTipCents: bad }).errors.join()).toContain('printedTipCents');
      expect(invalid({ ...sampleReceipt, printedSubtotalCents: bad }).errors.join()).toContain('printedSubtotalCents');
    }
  });

  it('rejects an item with a bad quantity, price, or name', () => {
    const withItem = (item: unknown) => invalid({ ...sampleReceipt, items: [item] }).errors.join();
    const good = { name: 'Beer', quantity: 1, lineTotalCents: 500 };
    expect(withItem({ ...good, quantity: 0 })).toContain('items[0].quantity');
    expect(withItem({ ...good, quantity: 1.5 })).toContain('items[0].quantity');
    expect(withItem({ ...good, lineTotalCents: -5 })).toContain('items[0].lineTotalCents');
    expect(withItem({ ...good, name: 7 })).toContain('items[0].name');
    expect(withItem('beer')).toContain('items[0]');
  });

  it('rejects malformed fees, tip sources, and warnings', () => {
    expect(invalid({ ...sampleReceipt, fees: [{ label: 'x', cents: -1 }] }).errors.join()).toContain('fees[0]');
    expect(invalid({ ...sampleReceipt, fees: [{ cents: 1 }] }).errors.join()).toContain('fees[0]');
    expect(invalid({ ...sampleReceipt, tipSource: 'venmo' }).errors.join()).toContain('tipSource');
    expect(invalid({ ...sampleReceipt, warnings: [1] }).errors.join()).toContain('warnings');
    expect(invalid({ ...sampleReceipt, items: 'none' }).errors.join()).toContain('items');
  });

  it('rejects missing fields', () => {
    const { warnings: _warnings, isReceipt: _isReceipt, ...rest } = sampleReceipt;
    const { errors } = invalid(rest);
    expect(errors.join()).toContain('isReceipt');
    expect(errors.join()).toContain('warnings');
  });

  it('collects every error instead of stopping at the first', () => {
    const { errors } = invalid({ ...sampleReceipt, taxCents: -1, discountCents: -1, currency: 'ZZZ' });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateLineItem', () => {
  it('accepts a good item and rejects a bad one', () => {
    expect(validateLineItem({ name: 'Beer', quantity: 2, lineTotalCents: 1700 })).toEqual({
      ok: true,
      item: { name: 'Beer', quantity: 2, lineTotalCents: 1700 },
    });
    expect(validateLineItem({ name: 'Beer', quantity: 0, lineTotalCents: 1700 }).ok).toBe(false);
  });
});

describe('ISO_4217_CODES', () => {
  it('covers the currencies the eval set calls for', () => {
    for (const code of ['USD', 'JPY', 'EUR', 'GBP', 'KWD', 'CAD', 'AUD']) {
      expect(ISO_4217_CODES.has(code)).toBe(true);
    }
  });
});
