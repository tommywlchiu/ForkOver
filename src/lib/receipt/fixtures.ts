/** Shared test data for the receipt modules. */
import type { ParsedReceipt } from './schema';

/** A tidy USD receipt: 2 x beer at 17.00, one katsu, tax, a printed tip, one fee. */
export const sampleReceipt: ParsedReceipt = {
  isReceipt: true,
  merchantName: 'Izakaya Test',
  currency: 'USD',
  items: [
    { name: 'Draft Beer', quantity: 2, lineTotalCents: 1700 },
    { name: 'Katsu', quantity: 1, lineTotalCents: 1895 },
  ],
  discountCents: 500,
  taxCents: 300,
  fees: [{ label: 'Service charge', cents: 200 }],
  printedTipCents: 400,
  tipSource: 'handwritten',
  printedSubtotalCents: 3595,
  printedTotalCents: 3995,
  warnings: [],
};

export const notAReceipt: ParsedReceipt = {
  isReceipt: false,
  merchantName: null,
  currency: '',
  items: [],
  discountCents: 0,
  taxCents: 0,
  fees: [],
  printedTipCents: null,
  tipSource: null,
  printedSubtotalCents: null,
  printedTotalCents: null,
  warnings: [],
};
