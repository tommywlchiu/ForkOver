/**
 * Compares what the model read against the hand-written expected answer. Pure:
 * no I/O, integer amounts only.
 */
import type { ParsedLineItem, ParsedReceipt } from '../schema.ts';
import type { ExpectedReceipt } from './expected.ts';

/** The pass/fail checks reported per receipt and in aggregate, in report order. */
export const CHECKS = [
  { key: 'itemsMatch', label: 'Every item and price' },
  { key: 'itemPricesMatch', label: 'Item prices' },
  { key: 'itemCountMatch', label: 'Item count' },
  { key: 'subtotalMatch', label: 'Subtotal' },
  { key: 'taxMatch', label: 'Tax' },
  { key: 'tipMatch', label: 'Tip' },
  { key: 'totalMatch', label: 'Total' },
  { key: 'currencyMatch', label: 'Currency' },
  { key: 'discountMatch', label: 'Discount' },
  { key: 'feesMatch', label: 'Fees' },
  { key: 'moneyMatch', label: 'Money right' },
  { key: 'allMatch', label: 'Everything right' },
] as const;
export type CheckKey = (typeof CHECKS)[number]['key'];

export type Score = Record<CheckKey, boolean> & {
  itemsMissing: number; // expected items the model did not return correctly
  itemsExtra: number; // returned items that match nothing expected
};

/** Names match ignoring case, punctuation, and spacing. */
export const normalizeItemName = (name: string): string =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const itemKey = (item: ParsedLineItem) => `${normalizeItemName(item.name)}|${item.quantity}|${item.lineTotalCents}`;
const priceKey = (item: ParsedLineItem) => `${item.quantity}|${item.lineTotalCents}`;

/**
 * Pairs items regardless of order. Two items pair when name, quantity, and line
 * total all match; duplicates pair one to one. `keyOf` picks what must agree.
 */
export function matchItems(
  actual: readonly ParsedLineItem[],
  expected: readonly ParsedLineItem[],
  keyOf: (item: ParsedLineItem) => string = itemKey,
) {
  const remaining = new Map<string, number>();
  for (const item of expected) remaining.set(keyOf(item), (remaining.get(keyOf(item)) ?? 0) + 1);
  let matched = 0;
  for (const item of actual) {
    const key = keyOf(item);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      matched += 1;
    }
  }
  return { matched, missing: expected.length - matched, extra: actual.length - matched };
}

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

export function scoreReceipt(actual: ParsedReceipt, expected: ExpectedReceipt): Score {
  const items = matchItems(actual.items, expected.items);
  const prices = matchItems(actual.items, expected.items, priceKey);
  const itemPricesMatch = prices.missing === 0 && prices.extra === 0;
  const checks = {
    itemsMatch: items.missing === 0 && items.extra === 0,
    itemPricesMatch,
    itemCountMatch: actual.items.length === expected.items.length,
    subtotalMatch: actual.printedSubtotalCents === expected.printedSubtotalCents,
    taxMatch: actual.taxCents === expected.taxCents,
    // No tip and a zero tip are the same answer, as in reconcile.
    tipMatch: (actual.printedTipCents ?? 0) === (expected.printedTipCents ?? 0),
    totalMatch: actual.printedTotalCents === expected.printedTotalCents,
    currencyMatch: actual.currency.trim().toUpperCase() === expected.currency.trim().toUpperCase(),
    discountMatch: actual.discountCents === expected.discountCents,
    feesMatch: sum(actual.fees.map((fee) => fee.cents)) === sum(expected.fees.map((fee) => fee.cents)),
  };
  // Money right ignores item names; everything else in the strict check stays.
  const { itemsMatch: _names, ...rest } = checks;
  const moneyMatch = Object.values(rest).every(Boolean);
  return {
    ...checks,
    moneyMatch,
    allMatch: Object.values(checks).every(Boolean),
    itemsMissing: items.missing,
    itemsExtra: items.extra,
  };
}
