import { sampleReceipt } from '../fixtures';
import { EXPECTED_KEYS, type ExpectedReceipt } from './expected';
import { matchItems, normalizeItemName, scoreReceipt } from './score';

const expected: ExpectedReceipt = {
  currency: 'USD',
  items: sampleReceipt.items,
  discountCents: 500,
  taxCents: 300,
  fees: [{ label: 'Service charge', cents: 200 }],
  printedTipCents: 400,
  printedSubtotalCents: 3595,
  printedTotalCents: 3995,
};

describe('normalizeItemName', () => {
  it('ignores case, punctuation, and spacing but keeps non-Latin letters', () => {
    expect(normalizeItemName('  Draft-Beer  (16oz) ')).toBe('draft beer 16oz');
    expect(normalizeItemName('ラーメン')).toBe('ラーメン');
  });
});

describe('matchItems', () => {
  it('pairs items in any order', () => {
    const reversed = [...expected.items].reverse();
    expect(matchItems(reversed, expected.items)).toEqual({ matched: 2, missing: 0, extra: 0 });
  });

  it('needs name, quantity, and line total all to agree', () => {
    const [beer, katsu] = expected.items;
    expect(matchItems([{ ...beer, lineTotalCents: 1800 }, katsu], expected.items)).toEqual({ matched: 1, missing: 1, extra: 1 });
    expect(matchItems([{ ...beer, quantity: 1 }, katsu], expected.items)).toEqual({ matched: 1, missing: 1, extra: 1 });
    expect(matchItems([{ ...beer, name: 'Lager' }, katsu], expected.items)).toEqual({ matched: 1, missing: 1, extra: 1 });
  });

  it('pairs duplicates one to one', () => {
    const twice = [expected.items[0], expected.items[0]];
    expect(matchItems([expected.items[0]], twice)).toEqual({ matched: 1, missing: 1, extra: 0 });
    expect(matchItems(twice, [expected.items[0]])).toEqual({ matched: 1, missing: 0, extra: 1 });
  });
});

describe('scoreReceipt', () => {
  it('passes everything for a perfect read', () => {
    const score = scoreReceipt(sampleReceipt, expected);
    expect(score).toMatchObject({ itemsMatch: true, allMatch: true, itemsMissing: 0, itemsExtra: 0 });
  });

  it('accepts differently cased item names and currency', () => {
    const items = sampleReceipt.items.map((i) => ({ ...i, name: i.name.toUpperCase() }));
    expect(scoreReceipt({ ...sampleReceipt, items, currency: 'usd' }, expected).allMatch).toBe(true);
  });

  it('fails only the check that is wrong', () => {
    const score = scoreReceipt({ ...sampleReceipt, taxCents: 301 }, expected);
    expect(score.taxMatch).toBe(false);
    expect(score.allMatch).toBe(false);
    expect(score).toMatchObject({ itemsMatch: true, subtotalMatch: true, tipMatch: true, totalMatch: true, currencyMatch: true });
  });

  it('flags a dropped item in both the items check and the count', () => {
    const score = scoreReceipt({ ...sampleReceipt, items: sampleReceipt.items.slice(0, 1) }, expected);
    expect(score).toMatchObject({ itemsMatch: false, itemCountMatch: false, itemsMissing: 1, itemsExtra: 0 });
  });

  it('flags a wrong price with matching count', () => {
    const items = [sampleReceipt.items[0], { ...sampleReceipt.items[1], lineTotalCents: 1985 }];
    expect(scoreReceipt({ ...sampleReceipt, items }, expected)).toMatchObject({
      itemsMatch: false,
      itemCountMatch: true,
      itemsMissing: 1,
      itemsExtra: 1,
    });
  });

  it('treats no tip and a zero tip as the same, but not a missing tip and a real one', () => {
    const noTip = { ...expected, printedTipCents: null };
    expect(scoreReceipt({ ...sampleReceipt, printedTipCents: 0 }, noTip).tipMatch).toBe(true);
    expect(scoreReceipt({ ...sampleReceipt, printedTipCents: null }, expected).tipMatch).toBe(false);
  });

  it('needs a null printed subtotal or total to match null', () => {
    const none = { ...expected, printedSubtotalCents: null, printedTotalCents: null };
    expect(scoreReceipt({ ...sampleReceipt, printedSubtotalCents: null, printedTotalCents: null }, none)).toMatchObject({
      subtotalMatch: true,
      totalMatch: true,
    });
    expect(scoreReceipt(sampleReceipt, none)).toMatchObject({ subtotalMatch: false, totalMatch: false });
  });

  it('compares fees by their total and discounts by amount', () => {
    const split = [{ label: 'A', cents: 50 }, { label: 'B', cents: 150 }];
    expect(scoreReceipt({ ...sampleReceipt, fees: split }, expected).feesMatch).toBe(true);
    expect(scoreReceipt({ ...sampleReceipt, fees: [] }, expected).feesMatch).toBe(false);
    expect(scoreReceipt({ ...sampleReceipt, discountCents: 0 }, expected).discountMatch).toBe(false);
  });

  it('scores a different currency', () => {
    expect(scoreReceipt({ ...sampleReceipt, currency: 'JPY' }, expected).currencyMatch).toBe(false);
  });
});

it('expected keys are all fields of a parsed receipt', () => {
  for (const key of EXPECTED_KEYS) expect(key in sampleReceipt).toBe(true);
});
