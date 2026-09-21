/**
 * Turns parsed model output into the draft bill the review screen edits.
 * See SPEC.md sections 6.5 and 7.5.
 */
import { allocate, type Fee, type Tip } from '../split/split';
import type { ParsedLineItem, ParsedReceipt, TipSource } from './schema';

export type DraftItem = { id: string; name: string; priceCents: number };

/**
 * A bill under review: everything the split engine needs except people and
 * claims, which come later. The tip is always an amount; percent tips are only
 * created when the payer picks one on the review screen.
 */
export type DraftBill = {
  currency: string;
  merchantName: string | null;
  items: DraftItem[];
  discountCents: number;
  taxCents: number;
  tip: Extract<Tip, { kind: 'amount' }>;
  /** Where the tip came from, for the "Printed tip" / "Handwritten tip" label. Null when none was read. */
  tipSource: TipSource | null;
  fees: Fee[];
  warnings: string[];
};

export type ToBillOptions = {
  /** Builds ids for items and fees. Defaults to `item-1`, `fee-1`, and so on (1-based, in order). */
  makeId?: (prefix: 'item' | 'fee', index: number) => string;
};

const defaultMakeId: NonNullable<ToBillOptions['makeId']> = (prefix, index) => `${prefix}-${index + 1}`;

/**
 * Expands a line of quantity N into N unit prices that add back up to the line
 * total; leftover minor units go to the earliest units (SPEC 6.5, FR-2).
 */
export function expandLine(line: ParsedLineItem): { name: string; priceCents: number }[] {
  return allocate(line.lineTotalCents, Array<number>(line.quantity).fill(1)).map((priceCents) => ({
    name: line.name,
    priceCents,
  }));
}

/** Expects a receipt that already passed `validateReceipt`. */
export function toBill(receipt: ParsedReceipt, options: ToBillOptions = {}): DraftBill {
  const makeId = options.makeId ?? defaultMakeId;

  const items = receipt.items
    .flatMap(expandLine)
    .map((unit, index): DraftItem => ({ id: makeId('item', index), ...unit }));

  const fees = receipt.fees.map(
    (fee, index): Fee => ({
      id: makeId('fee', index),
      label: fee.label,
      cents: fee.cents,
      split: 'proportional',
    }),
  );

  return {
    currency: receipt.currency,
    merchantName: receipt.merchantName,
    items,
    discountCents: receipt.discountCents,
    taxCents: receipt.taxCents,
    tip: { kind: 'amount', cents: receipt.printedTipCents ?? 0 },
    tipSource: receipt.printedTipCents === null ? null : receipt.tipSource,
    fees,
    warnings: receipt.warnings,
  };
}
