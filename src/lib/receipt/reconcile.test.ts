import { sampleReceipt } from './fixtures';
import type { ParsedReceipt } from './schema';
import { reconcile, reconcileReceipt, type ReconcileInput } from './reconcile';

const input = (overrides: Partial<ReconcileInput> = {}): ReconcileInput => ({
  itemsCents: 3595,
  discountCents: 500,
  taxCents: 300,
  feesCents: 200,
  tipCents: 400,
  printedSubtotalCents: 3595,
  printedTotalCents: 3995,
  ...overrides,
});

describe('reconcile: subtotal check', () => {
  it('matches when items equal the printed subtotal', () => {
    expect(reconcile(input()).subtotal).toEqual({ status: 'match', computedCents: 3595, printedCents: 3595 });
  });

  it('reports both numbers on a mismatch', () => {
    expect(reconcile(input({ itemsCents: 3495 })).subtotal).toEqual({
      status: 'mismatch',
      computedCents: 3495,
      printedCents: 3595,
    });
  });

  it('is unknown when the receipt printed no subtotal', () => {
    expect(reconcile(input({ printedSubtotalCents: null })).subtotal).toEqual({
      status: 'unknown',
      computedCents: 3595,
      printedCents: null,
    });
  });
});

describe('reconcile: total check', () => {
  it('matches when items - discount + tax + tip + fees equals the printed total', () => {
    expect(reconcile(input()).total).toEqual({ status: 'match', computedCents: 3995, printedCents: 3995 });
  });

  it('reports both numbers on a mismatch', () => {
    expect(reconcile(input({ printedTotalCents: 4100 })).total).toEqual({
      status: 'mismatch',
      computedCents: 3995,
      printedCents: 4100,
    });
  });

  it('treats a missing tip as zero', () => {
    const result = reconcile(input({ tipCents: null, printedTotalCents: 3595 }));
    expect(result.total).toEqual({ status: 'match', computedCents: 3595, printedCents: 3595 });
  });

  it('subtracts the discount and adds fees and tax', () => {
    const result = reconcile(
      input({ itemsCents: 1000, discountCents: 100, taxCents: 50, feesCents: 25, tipCents: 10, printedTotalCents: 985 }),
    );
    expect(result.total.status).toBe('match');
  });

  it('is unknown when the receipt printed no total', () => {
    expect(reconcile(input({ printedTotalCents: null })).total.status).toBe('unknown');
  });
});

describe('reconcile: unreadable tip check', () => {
  it('fires when no tip was read and the printed total exceeds items - discount + tax + fees', () => {
    // 3595 - 500 + 300 + 200 = 3595, printed total leaves 400 unexplained
    expect(reconcile(input({ tipCents: null })).unreadableTip).toBe(true);
  });

  it('does not fire when a tip was read', () => {
    expect(reconcile(input()).unreadableTip).toBe(false);
  });

  it('does not fire when the printed total equals the amount without a tip', () => {
    expect(reconcile(input({ tipCents: null, printedTotalCents: 3595 })).unreadableTip).toBe(false);
  });

  it('does not fire when the printed total is lower than the amount without a tip', () => {
    expect(reconcile(input({ tipCents: null, printedTotalCents: 3000 })).unreadableTip).toBe(false);
  });

  it('does not fire without a printed total', () => {
    expect(reconcile(input({ tipCents: null, printedTotalCents: null })).unreadableTip).toBe(false);
  });

  it('treats a zero tip like no tip', () => {
    expect(reconcile(input({ tipCents: 0 })).unreadableTip).toBe(true);
  });

  it('runs alongside the other checks without blocking them', () => {
    const result = reconcile(input({ tipCents: null, itemsCents: 3000 }));
    expect(result.subtotal.status).toBe('mismatch');
    expect(result.total.status).toBe('mismatch');
    expect(result.unreadableTip).toBe(true);
  });
});

describe('reconcileReceipt', () => {
  it('sums line totals and fees from the parsed receipt', () => {
    const result = reconcileReceipt(sampleReceipt);
    expect(result.subtotal.status).toBe('match');
    expect(result.total.status).toBe('match');
    expect(result.unreadableTip).toBe(false);
  });

  it('flags a receipt whose tip the model missed', () => {
    const missed: ParsedReceipt = { ...sampleReceipt, printedTipCents: null, tipSource: null };
    const result = reconcileReceipt(missed);
    expect(result.unreadableTip).toBe(true);
    expect(result.total).toMatchObject({ status: 'mismatch', computedCents: 3595, printedCents: 3995 });
  });
});
