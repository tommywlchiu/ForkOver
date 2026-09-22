/**
 * The fixture answer format: `<name>.expected.json` beside `<name>.jpg|.jpeg|.png`
 * in `fixtures/receipts/`. Its shape is picked from `ParsedReceipt` (schema.ts,
 * the single source), and it is validated with the same `validateReceipt` the
 * parser output goes through, so a typo in an expected file fails the same way a
 * bad model answer would. See fixtures/receipts/README.md.
 */
import { validateReceipt, type ParsedReceipt } from '../schema.ts';

/** What a person writes down about a photo. The other `ParsedReceipt` fields are not scored. */
export type ExpectedReceipt = Pick<
  ParsedReceipt,
  | 'currency'
  | 'items'
  | 'discountCents'
  | 'taxCents'
  | 'fees'
  | 'printedTipCents'
  | 'printedSubtotalCents'
  | 'printedTotalCents'
>;

export const EXPECTED_KEYS: readonly (keyof ExpectedReceipt)[] = [
  'currency',
  'items',
  'discountCents',
  'taxCents',
  'fees',
  'printedTipCents',
  'printedSubtotalCents',
  'printedTotalCents',
];

/** The kinds of receipt SPEC 7.7 requires the set to include. */
export const RECEIPT_KINDS = [
  'long',
  'crumpled',
  'handwritten-tip',
  'auto-gratuity',
  'discount',
  'surcharge',
  'quantity-line',
  'non-usd',
] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const MIN_FIXTURES = 12;

/** The optional keys of an expected file, on top of `ExpectedReceipt`. */
const EXTRA_KEYS = ['kinds', 'notes'];

export type ExpectedFile = { expected: ExpectedReceipt; kinds: ReceiptKind[]; notes: string | null };

export function parseExpectedFile(value: unknown): { ok: true; file: ExpectedFile } | { ok: false; errors: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['expected file must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  const known = new Set<string>([...EXPECTED_KEYS, ...EXTRA_KEYS]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`unknown key "${key}" (allowed: ${[...known].join(', ')})`);
  }
  for (const key of EXPECTED_KEYS) {
    if (!(key in record)) errors.push(`missing key "${key}"`);
  }

  let kinds: ReceiptKind[] = [];
  if (record.kinds !== undefined) {
    const list = record.kinds;
    if (!Array.isArray(list) || !list.every((k) => RECEIPT_KINDS.includes(k as ReceiptKind))) {
      errors.push(`kinds must be an array of: ${RECEIPT_KINDS.join(', ')}`);
    } else {
      kinds = list as ReceiptKind[];
    }
  }
  if (record.notes !== undefined && typeof record.notes !== 'string') errors.push('notes must be a string');
  if (errors.length > 0) return { ok: false, errors };

  const validation = validateReceipt({
    isReceipt: true,
    merchantName: null,
    tipSource: null,
    warnings: [],
    ...Object.fromEntries(EXPECTED_KEYS.map((key) => [key, record[key]])),
  });
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const r = validation.receipt;
  return {
    ok: true,
    file: {
      expected: {
        currency: r.currency,
        items: r.items,
        discountCents: r.discountCents,
        taxCents: r.taxCents,
        fees: r.fees,
        printedTipCents: r.printedTipCents,
        printedSubtotalCents: r.printedSubtotalCents,
        printedTotalCents: r.printedTotalCents,
      },
      kinds,
      notes: typeof record.notes === 'string' ? record.notes : null,
    },
  };
}

/** Notes for the report when the fixture set falls short of SPEC 7.7. */
export function coverageNotes(fixtures: readonly { kinds: readonly ReceiptKind[] }[]): string[] {
  const notes: string[] = [];
  if (fixtures.length < MIN_FIXTURES) {
    notes.push(`Only ${fixtures.length} fixtures; SPEC 7.7 asks for at least ${MIN_FIXTURES}.`);
  }
  const covered = new Set(fixtures.flatMap((f) => f.kinds));
  const missing = RECEIPT_KINDS.filter((kind) => !covered.has(kind));
  if (missing.length > 0) {
    notes.push(`No fixture is tagged with these required kinds: ${missing.join(', ')}.`);
  }
  return notes;
}
