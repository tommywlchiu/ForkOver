/**
 * Split math contract tests (revision 2, aligned with the ForkOver PRD).
 *
 * These tests ARE the spec for src/lib/split/split.ts. The implementation must
 * make them pass without editing this file. If a test looks wrong, stop and
 * ask the human instead of changing the expectation.
 *
 * Rules encoded here (see SPEC.md section 6, "Split math rules"):
 *  - All money is integer minor units ("cents"; whole yen for JPY). No floats.
 *  - allocate() uses the largest remainder method so shares always sum to the
 *    total. Ties go to the earliest entry. It builds the per-component breakdown.
 *  - Every bill has a payer (bill.payerId). Items nobody claimed count toward the
 *    payer (PRD FR-13).
 *  - Leftover pennies go to the payer (PRD FR-26): every other person's total is
 *    their exact share rounded down, and the payer's total is whatever remains.
 *    roundingCents reconciles each person's breakdown with their total.
 *  - A person with no items owes $0, including equal-split fees (PRD FR-28).
 *    Equal-split fees are shared only among people with at least one item.
 *  - Order of operations: item shares, then discount (by item subtotal), then tax,
 *    tip, and proportional fees (by post-discount subtotal), then equal fees.
 *
 * Runs under jest-expo (Jest globals) or Vitest with globals enabled.
 */
import {
  allocate,
  percentOf,
  calculateSplit,
  type Bill,
  type Item,
  type Person,
  type SplitResult,
} from './split';

// ---------- helpers ----------

const person = (id: string): Person => ({ id, name: id.toUpperCase() });

const item = (id: string, priceCents: number, assignedTo: string[]): Item => ({
  id,
  name: id,
  priceCents,
  assignedTo,
});

/** Defaults the payer to the first person unless the test says otherwise. */
const makeBill = (overrides: Partial<Bill> = {}): Bill => ({
  payerId: overrides.payerId ?? overrides.people?.[0]?.id ?? '',
  people: [],
  items: [],
  discountCents: 0,
  taxCents: 0,
  tip: { kind: 'amount', cents: 0 },
  fees: [],
  ...overrides,
});

function expectOk(result: SplitResult) {
  if (!result.ok) {
    throw new Error(`Expected ok result, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

function expectErr(result: SplitResult) {
  if (result.ok) {
    throw new Error('Expected validation errors, got ok result');
  }
  return result.errors;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Deterministic PRNG so the invariant tests are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact rational arithmetic on BigInt, used to check "never more than the exact share". */
type Frac = { n: bigint; d: bigint };
const bgcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
const frac = (n: bigint, d: bigint = 1n): Frac => {
  if (d < 0n) [n, d] = [-n, -d];
  const g = bgcd(n, d);
  return { n: n / g, d: d / g };
};
const fadd = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fsub = (a: Frac, b: Frac) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
const fdiv = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
const fint = (x: number) => frac(BigInt(x));

/**
 * Independent statement of each person's exact (unrounded) total, per SPEC.md 6.
 * Unclaimed items go to the payer. Tax, tip, and proportional fees follow each
 * person's post-discount subtotal; if that is zero for everyone, they split equally
 * among people with items (or all to the payer if nobody has items). Equal fees
 * split among people with items (or all to the payer if nobody has items).
 */
function exactTotals(bill: Bill, tipTotal: number): Frac[] {
  const ids = bill.people.map((p) => p.id);
  const eff = bill.items.map((it) => {
    const set = new Set(it.assignedTo);
    return set.size ? ids.filter((id) => set.has(id)) : [bill.payerId];
  });
  const hasItems = ids.map((id) => eff.some((e) => e.includes(id)));
  const anyItems = hasItems.some(Boolean);
  const fallback = ids.map((id, i) => (anyItems ? (hasItems[i] ? 1 : 0) : id === bill.payerId ? 1 : 0));
  const fbSum = sum(fallback);

  const S = sum(bill.items.map((it) => it.priceCents));
  const D = bill.discountCents;
  const P = S - D;
  const itemsEx = ids.map((id) =>
    bill.items.reduce(
      (acc, it, j) => (eff[j].includes(id) ? fadd(acc, frac(BigInt(it.priceCents), BigInt(eff[j].length))) : acc),
      fint(0),
    ),
  );
  const postEx = itemsEx.map((x) => (S > 0 ? fsub(x, fdiv(fmul(fint(D), x), fint(S))) : x));
  const propFees = sum(bill.fees.filter((f) => f.split === 'proportional').map((f) => f.cents));
  const eqFees = sum(bill.fees.filter((f) => f.split === 'equal').map((f) => f.cents));
  return ids.map((_, i) => {
    const propShare = P > 0 ? fdiv(postEx[i], fint(P)) : frac(BigInt(fallback[i]), BigInt(fbSum));
    const eqShare = frac(BigInt(fallback[i]), BigInt(fbSum));
    return fadd(
      fadd(postEx[i], fmul(fint(bill.taxCents + tipTotal + propFees), propShare)),
      fmul(fint(eqFees), eqShare),
    );
  });
}

const ffloor = (x: Frac) => {
  const q = x.n / x.d;
  return Number(x.n < 0n && x.n % x.d !== 0n ? q - 1n : q);
};

// ---------- allocate (unchanged from revision 1) ----------

describe('allocate', () => {
  it('splits evenly when the total divides cleanly', () => {
    expect(allocate(900, [1, 1, 1])).toEqual([300, 300, 300]);
  });

  it('gives a single leftover penny to the earliest entry on a tie', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  });

  it('gives multiple leftover pennies to the earliest entries on a tie', () => {
    expect(allocate(1001, [1, 1, 1])).toEqual([334, 334, 333]);
  });

  it('allocates proportionally to weights', () => {
    expect(allocate(1000, [3000, 1000])).toEqual([750, 250]);
  });

  it('gives the leftover penny to the largest remainder, not simply the earliest entry', () => {
    // 100 * 1/3 = 33.33, 100 * 2/3 = 66.67. The second entry has the larger remainder.
    expect(allocate(100, [1, 2])).toEqual([33, 67]);
  });

  it('never gives pennies to zero-weight entries when other weights are positive', () => {
    expect(allocate(7, [1, 0, 1])).toEqual([4, 0, 3]);
  });

  it('returns all zeros for a zero total', () => {
    expect(allocate(0, [5, 7])).toEqual([0, 0]);
  });

  it('falls back to an equal split when every weight is zero', () => {
    expect(allocate(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it('returns the full total for a single entry', () => {
    expect(allocate(1234, [42])).toEqual([1234]);
  });

  it('always sums exactly to the total (seeded fuzz)', () => {
    const rand = mulberry32(42);
    for (let run = 0; run < 500; run++) {
      const total = Math.floor(rand() * 100_000);
      const len = 1 + Math.floor(rand() * 12);
      const weights = Array.from({ length: len }, () =>
        rand() < 0.2 ? 0 : Math.floor(rand() * 50_000),
      );
      const shares = allocate(total, weights);
      expect(shares).toHaveLength(len);
      expect(sum(shares)).toBe(total);
      shares.forEach((s) => {
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it('throws on invalid input', () => {
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(10.5, [1])).toThrow();
    expect(() => allocate(10, [])).toThrow();
    expect(() => allocate(10, [1, -1])).toThrow();
    expect(() => allocate(10, [1, 0.5])).toThrow();
  });

  it('splits a quantity line into units whose prices add up to the line (PRD FR-2)', () => {
    // "3 x Beer $10.00" becomes three items priced 334, 333, 333.
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  });
});

// ---------- percentOf (unchanged from revision 1) ----------

describe('percentOf (basis points, 1800 = 18%)', () => {
  it('computes a clean percentage', () => {
    expect(percentOf(10_000, 1800)).toBe(1800);
  });

  it('rounds exactly half a cent up', () => {
    // 2725 * 18% = 490.5
    expect(percentOf(2725, 1800)).toBe(491);
  });

  it('rounds below half a cent down', () => {
    // 1234 * 18% = 222.12
    expect(percentOf(1234, 1800)).toBe(222);
  });

  it('handles fractional percentages via basis points', () => {
    // 8733 * 18.5% = 1615.605
    expect(percentOf(8733, 1850)).toBe(1616);
  });

  it('returns 0 for a zero base', () => {
    expect(percentOf(0, 2000)).toBe(0);
  });

  it('throws on invalid input', () => {
    expect(() => percentOf(-100, 1800)).toThrow();
    expect(() => percentOf(100, -1)).toThrow();
    expect(() => percentOf(100, 18.5)).toThrow();
  });
});

// ---------- calculateSplit: happy paths ----------

describe('calculateSplit', () => {
  it('handles individually ordered items with no extras', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b')],
          items: [item('burger', 1500, ['a']), item('pasta', 1800, ['b'])],
        }),
      ),
    );
    expect(result.shares).toEqual([
      { personId: 'a', itemsCents: 1500, discountCents: 0, taxCents: 0, tipCents: 0, feesCents: 0, roundingCents: 0, totalCents: 1500 },
      { personId: 'b', itemsCents: 1800, discountCents: 0, taxCents: 0, tipCents: 0, feesCents: 0, roundingCents: 0, totalCents: 1800 },
    ]);
    expect(result.totals).toEqual({
      subtotalCents: 3300,
      discountCents: 0,
      taxCents: 0,
      tipCents: 0,
      feesCents: 0,
      grandTotalCents: 3300,
    });
  });

  it('breaks breakdown penny ties by bill.people order, not assignedTo order', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b'), person('c')],
          items: [item('nachos', 1000, ['c', 'b', 'a'])],
        }),
      ),
    );
    expect(result.shares.map((s) => s.itemsCents)).toEqual([334, 333, 333]);
    // Payer is a, so the leftover penny stays with a in the totals too.
    expect(result.shares.map((s) => s.totalCents)).toEqual([334, 333, 333]);
  });

  it('sends leftover pennies to the payer, not to the first person (PRD FR-26)', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'c',
          people: [person('a'), person('b'), person('c')],
          items: [item('nachos', 1000, ['a', 'b', 'c'])],
        }),
      ),
    );
    // Everyone else pays floor(333.33) = 333; the payer covers the rest.
    expect(result.shares.map((s) => s.totalCents)).toEqual([333, 333, 334]);
    // The breakdown still shows a with 334 in items, reconciled by roundingCents.
    expect(result.shares.map((s) => s.itemsCents)).toEqual([334, 333, 333]);
    expect(result.shares.map((s) => s.roundingCents)).toEqual([-1, 0, 1]);
  });

  it('lets a payer with no items absorb rounding pennies', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'a',
          people: [person('a'), person('b'), person('c')],
          items: [item('platter', 1001, ['b', 'c'])],
        }),
      ),
    );
    // b and c each owe floor(500.5) = 500; the payer keeps the odd cent.
    expect(result.shares.map((s) => s.totalCents)).toEqual([1, 500, 500]);
    expect(result.shares.map((s) => s.roundingCents)).toEqual([1, -1, 0]);
  });

  it('ignores duplicate assignees on an item', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b')],
          items: [item('pizza', 1000, ['a', 'a', 'b'])],
        }),
      ),
    );
    expect(result.shares.map((s) => s.itemsCents)).toEqual([500, 500]);
  });

  it('returns shares in bill.people order', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('zoe'), person('adam'), person('mia')],
          items: [item('x', 300, ['mia', 'adam', 'zoe'])],
        }),
      ),
    );
    expect(result.shares.map((s) => s.personId)).toEqual(['zoe', 'adam', 'mia']);
  });

  it('allocates tax and a percent tip proportionally on a realistic receipt', () => {
    const bill = makeBill({
      payerId: 'a',
      people: [person('a'), person('b'), person('c')],
      items: [
        item('ramen', 1650, ['a']),
        item('katsu', 1895, ['b']),
        item('gyoza', 895, ['a', 'b', 'c']),
        item('beer', 850, ['c']),
        item('sake', 1200, ['b', 'c']),
      ],
      taxCents: 576,
      tip: { kind: 'percent', bps: 2000, base: 'preTax' },
    });
    const result = expectOk(calculateSplit(bill));

    // Breakdown (largest remainder per component, ties by people order):
    // gyoza 895 / 3 -> [299, 298, 298]; sake 1200 / 2 -> [0, 600, 600]
    expect(result.shares.map((s) => s.itemsCents)).toEqual([1949, 2793, 1748]);
    // tax 576 by [1949, 2793, 1748]: floors [172, 247, 155], 2 pennies to largest remainders a, b
    expect(result.shares.map((s) => s.taxCents)).toEqual([173, 248, 155]);
    // tip = 20% of 6490 = 1298, allocated by [1949, 2793, 1748]
    expect(result.shares.map((s) => s.tipCents)).toEqual([390, 559, 349]);
    // Totals: b's exact share is 3599.92 and c's is 2253.17, so they owe 3599 and 2253.
    // The payer (a) covers the remaining 2512.
    expect(result.shares.map((s) => s.totalCents)).toEqual([2512, 3599, 2253]);
    expect(result.shares.map((s) => s.roundingCents)).toEqual([0, -1, 1]);
    expect(result.totals).toEqual({
      subtotalCents: 6490,
      discountCents: 0,
      taxCents: 576,
      tipCents: 1298,
      feesCents: 0,
      grandTotalCents: 8364,
    });
  });

  it('computes a percent tip on the pre-tax or post-tax base as configured', () => {
    const base = {
      people: [person('a'), person('b'), person('c')],
      items: [
        item('ramen', 1650, ['a']),
        item('katsu', 1895, ['b']),
        item('gyoza', 895, ['a', 'b', 'c']),
        item('beer', 850, ['c']),
        item('sake', 1200, ['b', 'c']),
      ],
      taxCents: 576,
    };
    const preTax = expectOk(
      calculateSplit(makeBill({ ...base, tip: { kind: 'percent', bps: 1800, base: 'preTax' } })),
    );
    const postTax = expectOk(
      calculateSplit(makeBill({ ...base, tip: { kind: 'percent', bps: 1800, base: 'postTax' } })),
    );
    // 18% of 6490 = 1168.2 -> 1168
    expect(preTax.totals.tipCents).toBe(1168);
    // 18% of (6490 + 576) = 1271.88 -> 1272
    expect(postTax.totals.tipCents).toBe(1272);
    expect(sum(postTax.shares.map((s) => s.tipCents))).toBe(1272);
  });

  it('applies a receipt-level discount before tax and tip', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b')],
          items: [item('steak', 4000, ['a']), item('salad', 1000, ['b'])],
          discountCents: 1000,
          taxCents: 400,
          tip: { kind: 'amount', cents: 500 },
        }),
      ),
    );
    expect(result.shares).toEqual([
      { personId: 'a', itemsCents: 4000, discountCents: 800, taxCents: 320, tipCents: 400, feesCents: 0, roundingCents: 0, totalCents: 3920 },
      { personId: 'b', itemsCents: 1000, discountCents: 200, taxCents: 80, tipCents: 100, feesCents: 0, roundingCents: 0, totalCents: 980 },
    ]);
    expect(result.totals.grandTotalCents).toBe(4900);
  });

  it('uses the post-discount subtotal as the pre-tax tip base', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b')],
          items: [item('steak', 4000, ['a']), item('salad', 1000, ['b'])],
          discountCents: 1000,
          tip: { kind: 'percent', bps: 2000, base: 'preTax' },
        }),
      ),
    );
    // 20% of (5000 - 1000) = 800
    expect(result.totals.tipCents).toBe(800);
  });

  it('splits equal fees evenly and proportional fees by post-discount subtotal', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b'), person('c')],
          items: [item('x', 3000, ['a']), item('y', 1000, ['b']), item('z', 2000, ['c'])],
          fees: [
            { id: 'delivery', label: 'Delivery', cents: 499, split: 'equal' },
            { id: 'service', label: 'Service charge', cents: 600, split: 'proportional' },
          ],
        }),
      ),
    );
    // delivery 499 equal -> [167, 166, 166]; service 600 by [3000, 1000, 2000] -> [300, 100, 200]
    expect(result.shares.map((s) => s.feesCents)).toEqual([467, 266, 366]);
    expect(result.shares.map((s) => s.totalCents)).toEqual([3467, 1266, 2366]);
    expect(result.totals.feesCents).toBe(1099);
    expect(result.totals.grandTotalCents).toBe(7099);
  });

  it('charges a person with no items $0, including equal fees (PRD FR-28)', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b'), person('c')],
          items: [item('x', 2000, ['a']), item('y', 2000, ['b'])],
          taxCents: 300,
          tip: { kind: 'amount', cents: 400 },
          fees: [{ id: 'cake', label: 'Cake cutting fee', cents: 300, split: 'equal' }],
        }),
      ),
    );
    expect(result.shares[2]).toEqual({
      personId: 'c',
      itemsCents: 0,
      discountCents: 0,
      taxCents: 0,
      tipCents: 0,
      feesCents: 0,
      roundingCents: 0,
      totalCents: 0,
    });
    // The equal fee is shared only by the two people with items.
    expect(result.shares.map((s) => s.feesCents)).toEqual([150, 150, 0]);
    expect(result.shares.map((s) => s.totalCents)).toEqual([2500, 2500, 0]);
  });

  it('counts unclaimed items toward the payer (PRD FR-13)', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'a',
          people: [person('a'), person('b')],
          items: [item('x', 1000, ['b']), item('y', 600, [])],
          taxCents: 160,
        }),
      ),
    );
    expect(result.shares.map((s) => s.itemsCents)).toEqual([600, 1000]);
    expect(result.shares.map((s) => s.taxCents)).toEqual([60, 100]);
    expect(result.shares.map((s) => s.totalCents)).toEqual([660, 1100]);
  });

  it('counts unclaimed items toward the payer even when the payer is not first', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'b',
          people: [person('a'), person('b')],
          items: [item('x', 1000, ['a']), item('y', 600, [])],
        }),
      ),
    );
    expect(result.shares.map((s) => s.itemsCents)).toEqual([1000, 600]);
  });

  it('gives tax and fees to the payer when there are no items at all', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'b',
          people: [person('a'), person('b'), person('c')],
          taxCents: 100,
          fees: [{ id: 'f', label: 'Fee', cents: 50, split: 'equal' }],
        }),
      ),
    );
    expect(result.shares.map((s) => s.totalCents)).toEqual([0, 150, 0]);
  });

  it('falls back to an equal split of tax among people with items when the discount zeroes every subtotal', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a'), person('b'), person('c')],
          items: [item('x', 1000, ['a']), item('y', 500, ['b'])],
          discountCents: 1500,
          taxCents: 101,
        }),
      ),
    );
    expect(result.shares.map((s) => s.discountCents)).toEqual([1000, 500, 0]);
    expect(result.shares.map((s) => s.taxCents)).toEqual([51, 50, 0]);
    expect(result.shares.map((s) => s.totalCents)).toEqual([51, 50, 0]);
    expect(result.totals.grandTotalCents).toBe(101);
  });

  it('keeps the odd cent with the payer in the zero-subtotal fallback', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'b',
          people: [person('a'), person('b')],
          items: [item('x', 1000, ['a']), item('y', 500, ['b'])],
          discountCents: 1500,
          taxCents: 101,
        }),
      ),
    );
    // a owes floor(50.5) = 50; the payer covers 51.
    expect(result.shares.map((s) => s.totalCents)).toEqual([50, 51]);
  });

  it('allows free (zero-price) items', () => {
    const result = expectOk(
      calculateSplit(
        makeBill({
          people: [person('a')],
          items: [item('water', 0, ['a']), item('tea', 350, ['a'])],
        }),
      ),
    );
    expect(result.shares[0].totalCents).toBe(350);
  });

  it('works in currencies with no minor unit (PRD FR-30)', () => {
    // 1000 yen split three ways: the engine only sees integers, so yen behave like cents.
    const result = expectOk(
      calculateSplit(
        makeBill({
          payerId: 'a',
          people: [person('a'), person('b'), person('c')],
          items: [item('yakitori set', 1000, ['a', 'b', 'c'])],
        }),
      ),
    );
    expect(result.shares.map((s) => s.totalCents)).toEqual([334, 333, 333]);
  });
});

// ---------- calculateSplit: validation ----------

describe('calculateSplit validation', () => {
  it('rejects a bill with no people', () => {
    const errors = expectErr(calculateSplit(makeBill()));
    expect(errors).toContainEqual({ code: 'NO_PEOPLE' });
  });

  it('rejects a payer who is not on the bill', () => {
    const errors = expectErr(
      calculateSplit(
        makeBill({
          payerId: 'ghost',
          people: [person('a')],
          items: [item('x', 100, ['a'])],
        }),
      ),
    );
    expect(errors).toContainEqual({ code: 'UNKNOWN_PAYER', payerId: 'ghost' });
  });

  it('rejects duplicate person ids', () => {
    const errors = expectErr(
      calculateSplit(
        makeBill({
          people: [person('a'), person('a')],
          items: [item('x', 100, ['a'])],
        }),
      ),
    );
    expect(errors).toContainEqual({ code: 'DUPLICATE_PERSON_ID', personId: 'a' });
  });

  it('rejects an assignee who is not on the bill', () => {
    const errors = expectErr(
      calculateSplit(
        makeBill({
          people: [person('a')],
          items: [item('x', 100, ['a', 'ghost'])],
        }),
      ),
    );
    expect(errors).toContainEqual({ code: 'UNKNOWN_ASSIGNEE', itemId: 'x', personId: 'ghost' });
  });

  const invalidAmountCases: Array<[label: string, overrides: Partial<Bill>, field: string]> = [
    ['negative item price', { items: [item('x', -100, ['a'])] }, 'items.x.priceCents'],
    ['fractional item price', { items: [item('x', 12.5, ['a'])] }, 'items.x.priceCents'],
    ['NaN tax', { items: [item('x', 100, ['a'])], taxCents: Number.NaN }, 'taxCents'],
    ['negative discount', { items: [item('x', 100, ['a'])], discountCents: -1 }, 'discountCents'],
    ['negative tip amount', { items: [item('x', 100, ['a'])], tip: { kind: 'amount', cents: -5 } }, 'tip.cents'],
    [
      'fractional tip bps',
      { items: [item('x', 100, ['a'])], tip: { kind: 'percent', bps: 18.5, base: 'preTax' } },
      'tip.bps',
    ],
    [
      'infinite fee',
      {
        items: [item('x', 100, ['a'])],
        fees: [{ id: 'f1', label: 'Fee', cents: Number.POSITIVE_INFINITY, split: 'equal' }],
      },
      'fees.f1.cents',
    ],
  ];

  it.each(invalidAmountCases)('rejects %s', (_label, overrides, field) => {
    const errors = expectErr(calculateSplit(makeBill({ people: [person('a')], ...overrides })));
    expect(errors).toContainEqual({ code: 'INVALID_AMOUNT', field });
  });

  it('rejects a discount larger than the subtotal', () => {
    const errors = expectErr(
      calculateSplit(
        makeBill({
          people: [person('a')],
          items: [item('x', 1000, ['a'])],
          discountCents: 1001,
        }),
      ),
    );
    expect(errors).toContainEqual({ code: 'DISCOUNT_EXCEEDS_SUBTOTAL' });
  });

  it('reports every problem at once instead of stopping at the first', () => {
    const errors = expectErr(
      calculateSplit(
        makeBill({
          people: [person('a')],
          items: [item('x', 100, ['ghost'])],
          taxCents: -1,
        }),
      ),
    );
    expect(errors).toContainEqual({ code: 'UNKNOWN_ASSIGNEE', itemId: 'x', personId: 'ghost' });
    expect(errors).toContainEqual({ code: 'INVALID_AMOUNT', field: 'taxCents' });
  });
});

// ---------- calculateSplit: invariants ----------

describe('calculateSplit invariants (seeded fuzz)', () => {
  it('balances to the grand total, never charges anyone but the payer more than their exact share, and never goes negative', () => {
    const rand = mulberry32(2026);
    const int = (max: number) => Math.floor(rand() * max);

    for (let run = 0; run < 300; run++) {
      const people = Array.from({ length: 1 + int(8) }, (_, i) => person(`p${i}`));
      const payerId = people[int(people.length)].id;
      const items = Array.from({ length: int(16) }, (_, i) => {
        // About 1 in 6 items is left unclaimed, which puts it on the payer.
        const assignees = rand() < 0.17 ? [] : people.filter(() => rand() < 0.4).map((p) => p.id);
        return item(`i${i}`, int(8000), assignees);
      });
      const subtotal = sum(items.map((it) => it.priceCents));
      const tip: Bill['tip'] =
        rand() < 0.5
          ? { kind: 'amount', cents: int(3000) }
          : { kind: 'percent', bps: int(3500), base: rand() < 0.5 ? 'preTax' : 'postTax' };
      const bill = makeBill({
        payerId,
        people,
        items,
        discountCents: rand() < 0.3 ? int(subtotal + 1) : 0,
        taxCents: int(2000),
        tip,
        fees: Array.from({ length: int(3) }, (_, i) => ({
          id: `f${i}`,
          label: `Fee ${i}`,
          cents: int(1500),
          split: rand() < 0.5 ? ('equal' as const) : ('proportional' as const),
        })),
      });

      const result = expectOk(calculateSplit(bill));
      const { shares, totals } = result;

      expect(shares).toHaveLength(people.length);
      expect(sum(shares.map((s) => s.itemsCents))).toBe(totals.subtotalCents);
      expect(sum(shares.map((s) => s.discountCents))).toBe(totals.discountCents);
      expect(sum(shares.map((s) => s.taxCents))).toBe(totals.taxCents);
      expect(sum(shares.map((s) => s.tipCents))).toBe(totals.tipCents);
      expect(sum(shares.map((s) => s.feesCents))).toBe(totals.feesCents);
      expect(sum(shares.map((s) => s.roundingCents))).toBe(0);
      expect(sum(shares.map((s) => s.totalCents))).toBe(totals.grandTotalCents);
      expect(totals.grandTotalCents).toBe(
        totals.subtotalCents - totals.discountCents + totals.taxCents + totals.tipCents + totals.feesCents,
      );

      const exact = exactTotals(bill, totals.tipCents);
      shares.forEach((s, i) => {
        expect(s.discountCents).toBeLessThanOrEqual(s.itemsCents);
        expect(s.totalCents).toBeGreaterThanOrEqual(0);
        expect(s.totalCents).toBe(
          s.itemsCents - s.discountCents + s.taxCents + s.tipCents + s.feesCents + s.roundingCents,
        );
        if (s.personId !== payerId) {
          // PRD FR-26: everyone but the payer owes exactly floor(exact share).
          expect(s.totalCents).toBe(ffloor(exact[i]));
          const onAnyItem = items.some((it) => it.assignedTo.includes(s.personId));
          if (!onAnyItem) {
            // PRD FR-28: no items, no charges of any kind.
            expect(s).toEqual({
              personId: s.personId,
              itemsCents: 0,
              discountCents: 0,
              taxCents: 0,
              tipCents: 0,
              feesCents: 0,
              roundingCents: 0,
              totalCents: 0,
            });
          }
        }
      });
    }
  });
});
