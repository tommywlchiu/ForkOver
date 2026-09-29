/**
 * Canned `ParsedReceipt` results the stand-in reader replays (SPEC.md section
 * 11, M3). No live network call or API key needed to exercise Scan/Review.
 */
import type { ParsedReceipt } from '../schema';

/**
 * The realistic-receipt scenario from split.test.ts ("allocates tax and a
 * percent tip proportionally on a realistic receipt"): items totalling 6490,
 * tax 576. The receipt prints no tip, so the review screen's "No tip" chips
 * apply; picking the 20% pre-tax chip reproduces that test's exact bill and
 * its totals ($25.12, $35.99, $22.53 once claimed the same way).
 */
export const REALISTIC_RECEIPT: ParsedReceipt = {
  isReceipt: true,
  merchantName: 'Sakura Izakaya',
  currency: 'USD',
  rows: ['Ramen 16.50', 'Katsu 18.95', 'Gyoza 8.95', 'Beer 8.50', 'Sake 12.00', 'Subtotal 64.90', 'Tax 5.76'],
  items: [
    { name: 'Ramen', quantity: 1, lineTotalCents: 1650 },
    { name: 'Katsu', quantity: 1, lineTotalCents: 1895 },
    { name: 'Gyoza', quantity: 1, lineTotalCents: 895 },
    { name: 'Beer', quantity: 1, lineTotalCents: 850 },
    { name: 'Sake', quantity: 1, lineTotalCents: 1200 },
  ],
  discountCents: 0,
  taxCents: 576,
  fees: [],
  printedTipCents: null,
  tipSource: null,
  printedSubtotalCents: 6490,
  printedTotalCents: 7066,
  warnings: [],
};

export const STAND_IN_SCENARIOS = { realistic: REALISTIC_RECEIPT } as const;
export type StandInScenarioName = keyof typeof STAND_IN_SCENARIOS;
