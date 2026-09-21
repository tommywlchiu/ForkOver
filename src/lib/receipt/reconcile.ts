/**
 * The three receipt checks shown on the review screen. None of them block the
 * payer. See SPEC.md section 7.5.
 */
import type { ParsedReceipt } from './schema';

export type ReconcileInput = {
  /** Sum of the item prices as currently listed. */
  itemsCents: number;
  discountCents: number;
  taxCents: number;
  feesCents: number;
  /** Null when the receipt shows no tip. */
  tipCents: number | null;
  printedSubtotalCents: number | null;
  printedTotalCents: number | null;
};

/** `unknown` means the receipt printed no figure to compare against. */
export type AmountCheck =
  | { status: 'match'; computedCents: number; printedCents: number }
  | { status: 'mismatch'; computedCents: number; printedCents: number }
  | { status: 'unknown'; computedCents: number; printedCents: null };

export type Reconciliation = {
  /** Items against the printed subtotal (FR-3). */
  subtotal: AmountCheck;
  /** Items - discount + tax + tip + fees against the printed total. */
  total: AmountCheck;
  /** True when the printed total leaves room for a tip nobody read. */
  unreadableTip: boolean;
};

const compare = (computedCents: number, printedCents: number | null): AmountCheck => {
  if (printedCents === null) return { status: 'unknown', computedCents, printedCents };
  return {
    status: computedCents === printedCents ? 'match' : 'mismatch',
    computedCents,
    printedCents,
  };
};

export function reconcile(input: ReconcileInput): Reconciliation {
  const { itemsCents, discountCents, taxCents, feesCents, tipCents, printedTotalCents } = input;
  const withoutTip = itemsCents - discountCents + taxCents + feesCents;

  // A tip of zero is the same as none: nobody read one.
  const noTipRead = tipCents === null || tipCents === 0;

  return {
    subtotal: compare(itemsCents, input.printedSubtotalCents),
    total: compare(withoutTip + (tipCents ?? 0), printedTotalCents),
    unreadableTip: noTipRead && printedTotalCents !== null && printedTotalCents > withoutTip,
  };
}

/** Runs the checks on the receipt exactly as the model read it. */
export function reconcileReceipt(receipt: ParsedReceipt): Reconciliation {
  return reconcile({
    itemsCents: receipt.items.reduce((sum, item) => sum + item.lineTotalCents, 0),
    discountCents: receipt.discountCents,
    taxCents: receipt.taxCents,
    feesCents: receipt.fees.reduce((sum, fee) => sum + fee.cents, 0),
    tipCents: receipt.printedTipCents,
    printedSubtotalCents: receipt.printedSubtotalCents,
    printedTotalCents: receipt.printedTotalCents,
  });
}
