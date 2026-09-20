/**
 * Split engine: turns a bill into each person's share, to the cent.
 * See SPEC.md section 6. All money is integer minor units; no floats in the math.
 */

export type Person = { id: string; name: string };

export type Item = {
  id: string;
  name: string;
  priceCents: number;
  assignedTo: string[];
};

export type Tip =
  | { kind: 'amount'; cents: number }
  | { kind: 'percent'; bps: number; base: 'preTax' | 'postTax' };

export type Fee = { id: string; label: string; cents: number; split: 'proportional' | 'equal' };

export type Bill = {
  payerId: string;
  people: Person[];
  items: Item[];
  discountCents: number;
  taxCents: number;
  tip: Tip;
  fees: Fee[];
};

export type PersonShare = {
  personId: string;
  itemsCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  feesCents: number;
  roundingCents: number;
  totalCents: number;
};

export type BillTotals = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  feesCents: number;
  grandTotalCents: number;
};

export type SplitError =
  | { code: 'NO_PEOPLE' }
  | { code: 'UNKNOWN_PAYER'; payerId: string }
  | { code: 'DUPLICATE_PERSON_ID'; personId: string }
  | { code: 'UNKNOWN_ASSIGNEE'; itemId: string; personId: string }
  | { code: 'INVALID_AMOUNT'; field: string }
  | { code: 'DISCOUNT_EXCEEDS_SUBTOTAL' };

export type SplitResult =
  | { ok: true; shares: PersonShare[]; totals: BillTotals }
  | { ok: false; errors: SplitError[] };

const isCents = (value: number) => Number.isInteger(value) && value >= 0;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Largest remainder method: floor each proportional share, then hand out the
 * leftover minor units to the largest fractional remainders, ties to the
 * earliest entry. Shares always add back up to totalCents.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  if (!isCents(totalCents)) {
    throw new Error(`allocate: totalCents must be a non-negative integer, got ${totalCents}`);
  }
  if (weights.length === 0) {
    throw new Error('allocate: weights must not be empty');
  }
  for (const weight of weights) {
    if (!isCents(weight)) {
      throw new Error(`allocate: weights must be non-negative integers, got ${weight}`);
    }
  }

  const weightTotal = sum(weights);
  // Every weight zero: split equally instead of dividing by zero.
  const effective = weightTotal === 0 ? weights.map(() => 1) : weights;
  const effectiveTotal = weightTotal === 0 ? weights.length : weightTotal;

  const shares = effective.map((weight) => Math.floor((totalCents * weight) / effectiveTotal));
  const remainders = effective.map((weight) => (totalCents * weight) % effectiveTotal);
  const leftover = totalCents - sum(shares);

  const byRemainder = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < leftover; i++) {
    shares[byRemainder[i].index] += 1;
  }
  return shares;
}

/** Percentage in basis points (1800 = 18%), rounded half up. */
export function percentOf(baseCents: number, bps: number): number {
  if (!isCents(baseCents)) {
    throw new Error(`percentOf: baseCents must be a non-negative integer, got ${baseCents}`);
  }
  if (!isCents(bps)) {
    throw new Error(`percentOf: bps must be a non-negative integer, got ${bps}`);
  }
  return Math.floor((baseCents * bps + 5000) / 10000);
}

// ---------- exact rational arithmetic (BigInt), used only for the totals ----------

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
const fsub = (a: Frac, b: Frac) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
const fdiv = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
const fint = (x: number) => frac(BigInt(x));

const ffloor = (x: Frac): number => {
  const q = x.n / x.d;
  return Number(x.n < 0n && x.n % x.d !== 0n ? q - 1n : q);
};

// ---------- validation ----------

function validate(bill: Bill): SplitError[] {
  const errors: SplitError[] = [];

  if (bill.people.length === 0) {
    errors.push({ code: 'NO_PEOPLE' });
  }

  const knownIds = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const person of bill.people) {
    if (knownIds.has(person.id) && !reportedDuplicates.has(person.id)) {
      errors.push({ code: 'DUPLICATE_PERSON_ID', personId: person.id });
      reportedDuplicates.add(person.id);
    }
    knownIds.add(person.id);
  }

  if (bill.people.length > 0 && !knownIds.has(bill.payerId)) {
    errors.push({ code: 'UNKNOWN_PAYER', payerId: bill.payerId });
  }

  for (const item of bill.items) {
    if (!isCents(item.priceCents)) {
      errors.push({ code: 'INVALID_AMOUNT', field: `items.${item.id}.priceCents` });
    }
    const reportedAssignees = new Set<string>();
    for (const personId of item.assignedTo) {
      if (!knownIds.has(personId) && !reportedAssignees.has(personId)) {
        errors.push({ code: 'UNKNOWN_ASSIGNEE', itemId: item.id, personId });
        reportedAssignees.add(personId);
      }
    }
  }

  if (!isCents(bill.discountCents)) {
    errors.push({ code: 'INVALID_AMOUNT', field: 'discountCents' });
  }
  if (!isCents(bill.taxCents)) {
    errors.push({ code: 'INVALID_AMOUNT', field: 'taxCents' });
  }
  if (bill.tip.kind === 'amount') {
    if (!isCents(bill.tip.cents)) {
      errors.push({ code: 'INVALID_AMOUNT', field: 'tip.cents' });
    }
  } else if (!isCents(bill.tip.bps)) {
    errors.push({ code: 'INVALID_AMOUNT', field: 'tip.bps' });
  }
  for (const fee of bill.fees) {
    if (!isCents(fee.cents)) {
      errors.push({ code: 'INVALID_AMOUNT', field: `fees.${fee.id}.cents` });
    }
  }

  const pricesUsable = bill.items.every((item) => isCents(item.priceCents));
  if (pricesUsable && isCents(bill.discountCents)) {
    if (bill.discountCents > sum(bill.items.map((item) => item.priceCents))) {
      errors.push({ code: 'DISCOUNT_EXCEEDS_SUBTOTAL' });
    }
  }

  return errors;
}

// ---------- split ----------

export function calculateSplit(bill: Bill): SplitResult {
  const errors = validate(bill);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const ids = bill.people.map((person) => person.id);
  const payerIndex = ids.indexOf(bill.payerId);

  // Effective assignees per item, in bill.people order (which also dedupes and
  // breaks penny ties). An item nobody claimed goes to the payer (FR-13).
  const assignees: number[][] = bill.items.map((item) => {
    const claimed = new Set(item.assignedTo);
    const indexes = ids.map((id, index) => (claimed.has(id) ? index : -1)).filter((i) => i >= 0);
    return indexes.length > 0 ? indexes : [payerIndex];
  });

  const itemsCents = ids.map(() => 0);
  bill.items.forEach((item, itemIndex) => {
    const holders = assignees[itemIndex];
    const shares = allocate(
      item.priceCents,
      holders.map(() => 1),
    );
    holders.forEach((personIndex, k) => {
      itemsCents[personIndex] += shares[k];
    });
  });

  const subtotalCents = sum(bill.items.map((item) => item.priceCents));
  const discountShares = allocate(bill.discountCents, itemsCents);
  const postDiscount = itemsCents.map((cents, i) => cents - discountShares[i]);
  const postDiscountTotal = subtotalCents - bill.discountCents;

  const holdsItems = ids.map(() => false);
  assignees.forEach((holders) => holders.forEach((index) => (holdsItems[index] = true)));
  const anyoneHoldsItems = holdsItems.some(Boolean);
  // People with at least one item; nobody has one, so everything lands on the payer.
  const fallbackWeights = ids.map((_, i) =>
    anyoneHoldsItems ? (holdsItems[i] ? 1 : 0) : i === payerIndex ? 1 : 0,
  );
  const fallbackTotal = sum(fallbackWeights);
  const proportionalWeights = postDiscountTotal > 0 ? postDiscount : fallbackWeights;

  const tipTotalCents =
    bill.tip.kind === 'amount'
      ? bill.tip.cents
      : percentOf(
          bill.tip.base === 'postTax' ? postDiscountTotal + bill.taxCents : postDiscountTotal,
          bill.tip.bps,
        );

  const taxShares = allocate(bill.taxCents, proportionalWeights);
  const tipShares = allocate(tipTotalCents, proportionalWeights);

  const feeShares = ids.map(() => 0);
  for (const fee of bill.fees) {
    const shares = allocate(
      fee.cents,
      fee.split === 'equal' ? fallbackWeights : proportionalWeights,
    );
    shares.forEach((cents, i) => {
      feeShares[i] += cents;
    });
  }
  const feesTotalCents = sum(bill.fees.map((fee) => fee.cents));
  const proportionalFeesCents = sum(
    bill.fees.filter((fee) => fee.split === 'proportional').map((fee) => fee.cents),
  );
  const equalFeesCents = feesTotalCents - proportionalFeesCents;

  // Exact, unrounded share per person (SPEC 6.3 rule 4), in rational BigInt arithmetic.
  const itemsExact = ids.map((_, personIndex) =>
    bill.items.reduce(
      (acc, item, itemIndex) =>
        assignees[itemIndex].includes(personIndex)
          ? fadd(acc, frac(BigInt(item.priceCents), BigInt(assignees[itemIndex].length)))
          : acc,
      fint(0),
    ),
  );
  const postDiscountExact = itemsExact.map((items) =>
    subtotalCents > 0
      ? fsub(items, fdiv(fmul(fint(bill.discountCents), items), fint(subtotalCents)))
      : items,
  );
  const exactTotals = ids.map((_, i) => {
    const equalShare = frac(BigInt(fallbackWeights[i]), BigInt(fallbackTotal));
    const proportionalShare =
      postDiscountTotal > 0 ? fdiv(postDiscountExact[i], fint(postDiscountTotal)) : equalShare;
    return fadd(
      fadd(
        postDiscountExact[i],
        fmul(fint(bill.taxCents + tipTotalCents + proportionalFeesCents), proportionalShare),
      ),
      fmul(fint(equalFeesCents), equalShare),
    );
  });

  const grandTotalCents =
    subtotalCents - bill.discountCents + bill.taxCents + tipTotalCents + feesTotalCents;

  // Everyone but the payer owes their exact share rounded down; the payer covers
  // whatever is left, so the shares always add up to the receipt (FR-26).
  const totals = ids.map((_, i) => (i === payerIndex ? 0 : ffloor(exactTotals[i])));
  totals[payerIndex] = grandTotalCents - sum(totals);

  const shares: PersonShare[] = ids.map((personId, i) => {
    const breakdown =
      itemsCents[i] - discountShares[i] + taxShares[i] + tipShares[i] + feeShares[i];
    return {
      personId,
      itemsCents: itemsCents[i],
      discountCents: discountShares[i],
      taxCents: taxShares[i],
      tipCents: tipShares[i],
      feesCents: feeShares[i],
      roundingCents: totals[i] - breakdown,
      totalCents: totals[i],
    };
  });

  return {
    ok: true,
    shares,
    totals: {
      subtotalCents,
      discountCents: bill.discountCents,
      taxCents: bill.taxCents,
      tipCents: tipTotalCents,
      feesCents: feesTotalCents,
      grandTotalCents,
    },
  };
}
