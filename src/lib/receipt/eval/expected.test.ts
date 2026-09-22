import { sampleReceipt } from '../fixtures';
import { coverageNotes, MIN_FIXTURES, parseExpectedFile, RECEIPT_KINDS } from './expected';

const valid = {
  currency: 'usd',
  items: sampleReceipt.items,
  discountCents: 500,
  taxCents: 300,
  fees: sampleReceipt.fees,
  printedTipCents: 400,
  printedSubtotalCents: 3595,
  printedTotalCents: 3995,
  kinds: ['discount', 'quantity-line'],
  notes: 'fake',
};

describe('parseExpectedFile', () => {
  it('accepts a complete file and normalizes the currency', () => {
    const result = parseExpectedFile(valid);
    expect(result).toMatchObject({ ok: true, file: { kinds: ['discount', 'quantity-line'], notes: 'fake' } });
    if (result.ok) {
      expect(result.file.expected.currency).toBe('USD');
      expect(result.file.expected.items).toEqual(sampleReceipt.items);
    }
  });

  it('allows null for the printed figures and omits kinds and notes', () => {
    const { kinds, notes, ...bare } = valid;
    void kinds;
    void notes;
    const result = parseExpectedFile({ ...bare, printedTipCents: null, printedSubtotalCents: null, printedTotalCents: null });
    expect(result).toMatchObject({ ok: true, file: { kinds: [], notes: null } });
  });

  it('reports missing keys', () => {
    const { taxCents, ...rest } = valid;
    void taxCents;
    expect(parseExpectedFile(rest)).toEqual({ ok: false, errors: ['missing key "taxCents"'] });
  });

  it('rejects unknown keys so a typo cannot go unscored', () => {
    const result = parseExpectedFile({ ...valid, taxCent: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('unknown key "taxCent"');
  });

  it('runs the same validation as parser output', () => {
    const bad = parseExpectedFile({
      ...valid,
      currency: 'DOLLARS',
      items: [{ name: 'x', quantity: 0, lineTotalCents: -1 }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/currency.*quantity.*lineTotalCents/);
  });

  it('rejects an unknown kind and a non-object', () => {
    expect(parseExpectedFile({ ...valid, kinds: ['blurry'] }).ok).toBe(false);
    expect(parseExpectedFile([]).ok).toBe(false);
    expect(parseExpectedFile(null).ok).toBe(false);
  });
});

describe('coverageNotes', () => {
  const fixtures = (count: number, kinds = RECEIPT_KINDS as readonly (typeof RECEIPT_KINDS)[number][]) =>
    Array.from({ length: count }, () => ({ kinds }));

  it('has nothing to say for 12 fixtures covering every kind', () => {
    expect(coverageNotes(fixtures(MIN_FIXTURES))).toEqual([]);
  });

  it('notes a short set and lists the missing kinds', () => {
    const notes = coverageNotes([{ kinds: ['long'] }]);
    expect(notes[0]).toContain('Only 1 fixtures');
    expect(notes[1]).toContain('crumpled');
    expect(notes[1]).not.toContain('long');
  });
});
