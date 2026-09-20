/**
 * Paid tracking and balances. See SPEC.md section 6.4.
 *
 * Pipeline: resolveClaims -> calculateSplit -> computeBalances (memoized per bill).
 * A portion is one person's share of one item, keyed by (itemId, personId).
 */
import type { Bill, BillTotals, Item, PersonShare } from '../split/split';

export type Portion = { itemId: string; personId: string };

export type PersonBalance = {
  personId: string;
  totalCents: number;
  paidCents: number;
  /** max(0, totalCents - paidCents). Not shown for the payer in the UI. */
  remainingCents: number;
};

export function portionKey(portion: Portion): string {
  return `${portion.itemId}:${portion.personId}`;
}

/**
 * The holders of one item's portions: its claimed assignees in bill.people
 * order, or the payer alone if nobody claimed it (matches calculateSplit's
 * fallback so a portion exists for every dollar on the bill).
 */
function holdersForItem(item: Item, bill: Bill): string[] {
  const peopleIds = bill.people.map((person) => person.id);
  const claimed = new Set(item.assignedTo);
  const holders = peopleIds.filter((id) => claimed.has(id));
  return holders.length > 0 ? holders : [bill.payerId];
}

export function portionsForItem(item: Item, bill: Bill): Portion[] {
  return holdersForItem(item, bill).map((personId) => ({ itemId: item.id, personId }));
}

export function portionsForBill(bill: Bill): Portion[] {
  return bill.items.flatMap((item) => portionsForItem(item, bill));
}

export function portionsForPerson(bill: Bill, personId: string): Portion[] {
  return portionsForBill(bill).filter((portion) => portion.personId === personId);
}

/** An item with any paid portion is locked (SPEC FR-17): no edits, no reclaiming. */
export function isItemLocked(itemId: string, paidPortions: Portion[]): boolean {
  return paidPortions.some((portion) => portion.itemId === itemId);
}

// ---------- exact rational arithmetic (BigInt), used only for attributed cost ----------

type Frac = { n: bigint; d: bigint };

const bgcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
};

const frac = (n: bigint, d: bigint = 1n): Frac => {
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = bgcd(num, den);
  return { n: num / g, d: den / g };
};

const fadd = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
const fdiv = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
const fint = (x: number) => frac(BigInt(x));

const ffloor = (x: Frac): number => {
  const q = x.n / x.d;
  return Number(x.n < 0n && x.n % x.d !== 0n ? q - 1n : q);
};

/**
 * computeBalances(bill, totals, shares, paidPortions) -> each person's paid
 * and remaining amount.
 *
 * S = subtotal, D = discount, X = tax + tip + proportional fees (equal fees
 * are excluded: they aren't tied to any item, so they only settle once every
 * one of a person's portions is paid). A portion's attributed cost is its
 * exact item share (unrounded) times (S - D + X) / S.
 *
 * A person's paidCents is their totalCents once every portion they're on is
 * paid; otherwise it's the floor of the sum of attributed costs of their
 * paid portions. If S - D is 0, paidCents is 0 until every portion is paid.
 */
export function computeBalances(input: {
  bill: Bill;
  totals: BillTotals;
  shares: PersonShare[];
  paidPortions: Portion[];
}): PersonBalance[] {
  const { bill, totals, shares, paidPortions } = input;

  const subtotalCents = totals.subtotalCents;
  const postDiscountCents = subtotalCents - totals.discountCents;
  const proportionalFeesCents = sum(
    bill.fees.filter((fee) => fee.split === 'proportional').map((fee) => fee.cents),
  );
  const xCents = totals.taxCents + totals.tipCents + proportionalFeesCents;

  const paidKeys = new Set(paidPortions.map(portionKey));
  const itemById = new Map(bill.items.map((item) => [item.id, item]));

  return shares.map((share) => {
    const portions = portionsForPerson(bill, share.personId);
    const everyPortionPaid =
      portions.length > 0 && portions.every((portion) => paidKeys.has(portionKey(portion)));

    let paidCents: number;
    if (portions.length === 0) {
      // No items -> nothing to pay, vacuously "every portion paid".
      paidCents = share.totalCents;
    } else if (everyPortionPaid) {
      // Bypass per-portion rounding so a fully paid person's paidCents always
      // matches totalCents exactly, even though individual attributed costs
      // don't necessarily add back up to it.
      paidCents = share.totalCents;
    } else if (postDiscountCents === 0) {
      paidCents = 0;
    } else {
      let attributed: Frac = fint(0);
      for (const portion of portions) {
        if (!paidKeys.has(portionKey(portion))) continue;
        const item = itemById.get(portion.itemId);
        if (!item) continue;
        const holders = holdersForItem(item, bill).length;
        const itemShare = fdiv(fint(item.priceCents), fint(holders));
        const factor = fdiv(fint(postDiscountCents + xCents), fint(subtotalCents));
        attributed = fadd(attributed, fmul(itemShare, factor));
      }
      paidCents = Math.max(0, ffloor(attributed));
    }

    return {
      personId: share.personId,
      totalCents: share.totalCents,
      paidCents,
      remainingCents: Math.max(0, share.totalCents - paidCents),
    };
  });
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
