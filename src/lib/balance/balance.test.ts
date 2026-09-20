/**
 * Balance contract tests. See SPEC.md section 6.4, including the worked
 * example (the realistic receipt from split.test.ts: payer a; b owes 3599).
 */
import { calculateSplit, type Bill } from '../split/split';
import { computeBalances, isItemLocked, portionsForBill, portionsForPerson } from './balance';

function expectOk<T extends { ok: boolean }>(result: T) {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result)}`);
  }
  return result as T & { ok: true };
}

const realisticReceipt: Bill = {
  payerId: 'a',
  people: [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
    { id: 'c', name: 'Cate' },
  ],
  items: [
    { id: 'ramen', name: 'Ramen', priceCents: 1650, assignedTo: ['a'] },
    { id: 'katsu', name: 'Katsu', priceCents: 1895, assignedTo: ['b'] },
    { id: 'gyoza', name: 'Gyoza', priceCents: 895, assignedTo: ['a', 'b', 'c'] },
    { id: 'beer', name: 'Beer', priceCents: 850, assignedTo: ['c'] },
    { id: 'sake', name: 'Sake', priceCents: 1200, assignedTo: ['b', 'c'] },
  ],
  discountCents: 0,
  taxCents: 576,
  tip: { kind: 'percent', bps: 2000, base: 'preTax' },
  fees: [],
};

describe('computeBalances', () => {
  it('worked example: marks b’s katsu paid, then the rest of b’s portions', () => {
    const result = expectOk(calculateSplit(realisticReceipt));
    expect(result.shares.map((s) => s.totalCents)).toEqual([2512, 3599, 2253]);

    const afterKatsu = computeBalances({
      bill: realisticReceipt,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [{ itemId: 'katsu', personId: 'b' }],
    });
    const b1 = afterKatsu.find((balance) => balance.personId === 'b')!;
    expect(b1.paidCents).toBe(2442);
    expect(b1.remainingCents).toBe(1157);

    const afterAll = computeBalances({
      bill: realisticReceipt,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [
        { itemId: 'katsu', personId: 'b' },
        { itemId: 'gyoza', personId: 'b' },
        { itemId: 'sake', personId: 'b' },
      ],
    });
    const b2 = afterAll.find((balance) => balance.personId === 'b')!;
    expect(b2.paidCents).toBe(3599);
    expect(b2.remainingCents).toBe(0);
  });

  it('a person with no paid portions owes their full remaining amount', () => {
    const result = expectOk(calculateSplit(realisticReceipt));
    const balances = computeBalances({
      bill: realisticReceipt,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [],
    });
    const c = balances.find((balance) => balance.personId === 'c')!;
    expect(c.paidCents).toBe(0);
    expect(c.remainingCents).toBe(2253);
  });

  it('a person with no items owes and has paid $0', () => {
    const noItemsBill: Bill = {
      ...realisticReceipt,
      people: [...realisticReceipt.people, { id: 'd', name: 'Dana' }],
    };
    const result = expectOk(calculateSplit(noItemsBill));
    const balances = computeBalances({
      bill: noItemsBill,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [],
    });
    const d = balances.find((balance) => balance.personId === 'd')!;
    expect(d.totalCents).toBe(0);
    expect(d.paidCents).toBe(0);
    expect(d.remainingCents).toBe(0);
  });

  it('paidCents is 0 until every portion is paid when the post-discount subtotal is 0', () => {
    const bill: Bill = {
      payerId: 'a',
      people: [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
      ],
      items: [{ id: 'x', name: 'X', priceCents: 1000, assignedTo: ['a', 'b'] }],
      discountCents: 1000,
      taxCents: 0,
      tip: { kind: 'amount', cents: 200 },
      fees: [],
    };
    const result = expectOk(calculateSplit(bill));
    const withOnePaid = computeBalances({
      bill,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [{ itemId: 'x', personId: 'b' }],
    });
    const b = withOnePaid.find((balance) => balance.personId === 'b')!;
    // b's only portion is paid, so paidCents equals totalCents exactly (the
    // "every portion paid" rule), not the S-D=0 fallback of 0.
    expect(b.paidCents).toBe(b.totalCents);
  });

  it('every share adds up: total paid plus total remaining across the bill', () => {
    const result = expectOk(calculateSplit(realisticReceipt));
    const balances = computeBalances({
      bill: realisticReceipt,
      totals: result.totals,
      shares: result.shares,
      paidPortions: [{ itemId: 'katsu', personId: 'b' }],
    });
    for (const balance of balances) {
      expect(balance.paidCents + balance.remainingCents).toBeGreaterThanOrEqual(balance.totalCents);
      expect(balance.paidCents).toBeLessThanOrEqual(balance.totalCents);
    }
  });
});

describe('portionsForBill / portionsForPerson', () => {
  it('enumerates one portion per (item, holder) pair', () => {
    const portions = portionsForBill(realisticReceipt);
    // ramen(1) + katsu(1) + gyoza(3) + beer(1) + sake(2) = 8
    expect(portions).toHaveLength(8);
  });

  it('assigns an unclaimed item’s portion to the payer', () => {
    const bill: Bill = {
      ...realisticReceipt,
      items: [...realisticReceipt.items, { id: 'mystery', name: 'Mystery', priceCents: 100, assignedTo: [] }],
    };
    const portions = portionsForPerson(bill, 'a');
    expect(portions).toContainEqual({ itemId: 'mystery', personId: 'a' });
  });

  it('filters to one person’s portions', () => {
    const portions = portionsForPerson(realisticReceipt, 'b');
    expect(portions.map((p) => p.itemId).sort()).toEqual(['gyoza', 'katsu', 'sake']);
  });
});

describe('isItemLocked', () => {
  it('is false with no paid portions on the item', () => {
    expect(isItemLocked('katsu', [{ itemId: 'gyoza', personId: 'a' }])).toBe(false);
  });

  it('is true once any portion on the item is paid', () => {
    expect(isItemLocked('katsu', [{ itemId: 'katsu', personId: 'b' }])).toBe(true);
  });
});
