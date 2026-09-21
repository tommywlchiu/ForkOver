import { calculateSplit } from '../split/split';
import { notAReceipt, sampleReceipt } from './fixtures';
import type { ParsedReceipt } from './schema';
import { expandLine, toBill } from './toBill';

const receipt = (overrides: Partial<ParsedReceipt>): ParsedReceipt => ({ ...sampleReceipt, ...overrides });

describe('toBill', () => {
  it('expands a quantity line into separate items named like the line', () => {
    const bill = toBill(receipt({ items: [{ name: 'Draft Beer', quantity: 2, lineTotalCents: 1700 }] }));
    expect(bill.items).toEqual([
      { id: 'item-1', name: 'Draft Beer', priceCents: 850 },
      { id: 'item-2', name: 'Draft Beer', priceCents: 850 },
    ]);
  });

  it('gives the leftover cents to the earliest units so the line still adds up', () => {
    const bill = toBill(receipt({ items: [{ name: 'Wings', quantity: 3, lineTotalCents: 1000 }] }));
    expect(bill.items.map((i) => i.priceCents)).toEqual([334, 333, 333]);
    expect(bill.items.reduce((sum, i) => sum + i.priceCents, 0)).toBe(1000);
  });

  it('keeps a quantity of one as a single item and numbers ids across lines in order', () => {
    const bill = toBill(sampleReceipt);
    expect(bill.items).toEqual([
      { id: 'item-1', name: 'Draft Beer', priceCents: 850 },
      { id: 'item-2', name: 'Draft Beer', priceCents: 850 },
      { id: 'item-3', name: 'Katsu', priceCents: 1895 },
    ]);
  });

  it('expands whole-unit currencies without inventing minor units', () => {
    const bill = toBill(
      receipt({ currency: 'JPY', items: [{ name: 'Highball', quantity: 3, lineTotalCents: 1000 }] }),
    );
    expect(bill.items.map((i) => i.priceCents)).toEqual([334, 333, 333]);
    expect(bill.currency).toBe('JPY');
  });

  it('turns a printed tip into an amount tip and keeps its source', () => {
    const bill = toBill(receipt({ printedTipCents: 400, tipSource: 'handwritten' }));
    expect(bill.tip).toEqual({ kind: 'amount', cents: 400 });
    expect(bill.tipSource).toBe('handwritten');
  });

  it('turns no tip into a zero amount tip with no source', () => {
    const bill = toBill(receipt({ printedTipCents: null, tipSource: null }));
    expect(bill.tip).toEqual({ kind: 'amount', cents: 0 });
    expect(bill.tipSource).toBeNull();
  });

  it('defaults every fee to a proportional split', () => {
    const bill = toBill(
      receipt({
        fees: [
          { label: 'Service charge', cents: 200 },
          { label: 'Delivery', cents: 350 },
        ],
      }),
    );
    expect(bill.fees).toEqual([
      { id: 'fee-1', label: 'Service charge', cents: 200, split: 'proportional' },
      { id: 'fee-2', label: 'Delivery', cents: 350, split: 'proportional' },
    ]);
  });

  it('carries currency, merchant, discount, tax, and warnings through', () => {
    const bill = toBill(receipt({ currency: 'EUR', merchantName: 'Café', warnings: ['bottom cut off'] }));
    expect(bill).toMatchObject({
      currency: 'EUR',
      merchantName: 'Café',
      discountCents: 500,
      taxCents: 300,
      warnings: ['bottom cut off'],
    });
  });

  it('uses the id factory when given one', () => {
    const bill = toBill(sampleReceipt, { makeId: (prefix, index) => `${prefix}_${index}` });
    expect(bill.items.map((i) => i.id)).toEqual(['item_0', 'item_1', 'item_2']);
    expect(bill.fees.map((f) => f.id)).toEqual(['fee_0']);
  });

  it('turns an empty receipt into an empty bill', () => {
    expect(toBill(notAReceipt)).toMatchObject({ items: [], fees: [], tip: { kind: 'amount', cents: 0 } });
  });

  it('feeds the split engine so shares add up to what the draft bill totals', () => {
    const bill = toBill(sampleReceipt);
    const result = calculateSplit({
      payerId: 'a',
      people: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      items: bill.items.map((item, index) => ({ ...item, assignedTo: [index % 2 === 0 ? 'a' : 'b'] })),
      discountCents: bill.discountCents,
      taxCents: bill.taxCents,
      tip: bill.tip,
      fees: bill.fees,
    });
    if (!result.ok) throw new Error('split failed');
    // items 3595 - discount 500 + tax 300 + tip 400 + fee 200
    expect(result.totals.grandTotalCents).toBe(3995);
    expect(result.shares.reduce((sum, share) => sum + share.totalCents, 0)).toBe(3995);
  });
});

describe('expandLine', () => {
  it('returns one unit per quantity', () => {
    expect(expandLine({ name: 'Tea', quantity: 4, lineTotalCents: 1000 })).toHaveLength(4);
  });
});
