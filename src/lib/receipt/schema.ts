/**
 * Single source for the parsed-receipt type, its JSON schema, and runtime
 * validation. See SPEC.md section 7.3.
 *
 * This file is imported by the app and by the parse-receipt Edge Function
 * (Deno), so it must stay dependency-free.
 */

export type TipSource = 'printed' | 'handwritten' | 'autoGratuity' | 'mixed';

export type ParsedLineItem = {
  name: string;
  quantity: number;
  lineTotalCents: number; // minor units, for the whole line
};

export type ParsedFee = { label: string; cents: number };

export type ParsedReceipt = {
  isReceipt: boolean;
  merchantName: string | null;
  currency: string; // ISO 4217 as printed or inferred, e.g. "USD", "JPY"
  items: ParsedLineItem[];
  discountCents: number; // sum of discounts, coupons, comps, as a positive number
  taxCents: number; // sum of tax lines added on top; 0 when tax is included in prices
  fees: ParsedFee[]; // surcharges, delivery, and other non-tip fees
  printedTipCents: number | null; // auto-gratuity plus any printed or handwritten tip
  tipSource: TipSource | null;
  printedSubtotalCents: number | null;
  printedTotalCents: number | null; // final total line (handwritten total if present)
  warnings: string[]; // e.g. "bottom of receipt cut off", "handwritten tip unclear"
};

export const TIP_SOURCES: readonly TipSource[] = ['printed', 'handwritten', 'autoGratuity', 'mixed'];

/**
 * JSON schema sent as `output_config.format.schema`. Structured outputs need
 * `additionalProperties: false` on every object, every property listed in
 * `required`, and no numeric constraints, so ranges are enforced in
 * `validateReceipt`. Property order matters: the model writes fields in this
 * order, and items come after the fields the review screen needs first.
 */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    isReceipt: { type: 'boolean' },
    merchantName: nullable({ type: 'string' }),
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'integer' },
          lineTotalCents: { type: 'integer' },
        },
        required: ['name', 'quantity', 'lineTotalCents'],
        additionalProperties: false,
      },
    },
    discountCents: { type: 'integer' },
    taxCents: { type: 'integer' },
    fees: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          cents: { type: 'integer' },
        },
        required: ['label', 'cents'],
        additionalProperties: false,
      },
    },
    printedTipCents: nullable({ type: 'integer' }),
    tipSource: nullable({ type: 'string', enum: [...TIP_SOURCES] }),
    printedSubtotalCents: nullable({ type: 'integer' }),
    printedTotalCents: nullable({ type: 'integer' }),
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'isReceipt',
    'merchantName',
    'currency',
    'items',
    'discountCents',
    'taxCents',
    'fees',
    'printedTipCents',
    'tipSource',
    'printedSubtotalCents',
    'printedTotalCents',
    'warnings',
  ],
  additionalProperties: false,
} as const;

/** Active ISO 4217 currency codes. */
export const ISO_4217_CODES: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP ' +
    'BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP ' +
    'GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR ' +
    'KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK ' +
    'MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR ' +
    'SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS ' +
    'UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG'
  ).split(' '),
);

export type ReceiptValidation =
  | { ok: true; receipt: ParsedReceipt }
  | { ok: false; code: 'INVALID_OUTPUT'; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-negative integer amount in minor units. */
export const isCentsValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Validates one line item as it streams in. Returns the cleaned item, or the
 * reasons it was rejected. `path` prefixes each error, for example `items[2]`.
 */
export function validateLineItem(
  value: unknown,
  path = 'item',
): { ok: true; item: ParsedLineItem } | { ok: false; errors: string[] } {
  if (!isRecord(value)) return { ok: false, errors: [`${path} must be an object`] };
  const errors: string[] = [];
  if (typeof value.name !== 'string') errors.push(`${path}.name must be a string`);
  if (typeof value.quantity !== 'number' || !Number.isInteger(value.quantity) || value.quantity < 1) {
    errors.push(`${path}.quantity must be an integer of at least 1`);
  }
  if (!isCentsValue(value.lineTotalCents)) {
    errors.push(`${path}.lineTotalCents must be a non-negative integer`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    item: {
      name: value.name as string,
      quantity: value.quantity as number,
      lineTotalCents: value.lineTotalCents as number,
    },
  };
}

/**
 * Validates parsed model output against SPEC 7.3: amounts are non-negative
 * integers, quantity is an integer of at least 1, currency is a known ISO 4217
 * code. Collects every problem instead of stopping at the first. Unknown extra
 * keys are dropped. A non-receipt only needs the right shape, since its
 * arrays are empty and its amounts zero.
 */
export function validateReceipt(value: unknown): ReceiptValidation {
  if (!isRecord(value)) {
    return { ok: false, code: 'INVALID_OUTPUT', errors: ['receipt must be an object'] };
  }
  const errors: string[] = [];

  if (typeof value.isReceipt !== 'boolean') errors.push('isReceipt must be a boolean');

  const merchantName = value.merchantName;
  if (merchantName !== null && typeof merchantName !== 'string') {
    errors.push('merchantName must be a string or null');
  }

  let currency = '';
  if (typeof value.currency !== 'string') {
    errors.push('currency must be a string');
  } else {
    currency = value.currency.trim().toUpperCase();
    if (value.isReceipt === true && !ISO_4217_CODES.has(currency)) {
      errors.push(`currency must be a known ISO 4217 code, got "${value.currency}"`);
    }
  }

  const items: ParsedLineItem[] = [];
  if (!Array.isArray(value.items)) {
    errors.push('items must be an array');
  } else {
    value.items.forEach((entry, index) => {
      const result = validateLineItem(entry, `items[${index}]`);
      if (result.ok) items.push(result.item);
      else errors.push(...result.errors);
    });
  }

  if (!isCentsValue(value.discountCents)) errors.push('discountCents must be a non-negative integer');
  if (!isCentsValue(value.taxCents)) errors.push('taxCents must be a non-negative integer');

  const fees: ParsedFee[] = [];
  if (!Array.isArray(value.fees)) {
    errors.push('fees must be an array');
  } else {
    value.fees.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.label !== 'string' || !isCentsValue(entry.cents)) {
        errors.push(`fees[${index}] must have a string label and a non-negative integer cents`);
      } else {
        fees.push({ label: entry.label, cents: entry.cents });
      }
    });
  }

  const nullableCents = (field: string, entry: unknown): number | null => {
    if (entry === null) return null;
    if (!isCentsValue(entry)) errors.push(`${field} must be a non-negative integer or null`);
    return entry as number;
  };
  const printedTipCents = nullableCents('printedTipCents', value.printedTipCents);
  const printedSubtotalCents = nullableCents('printedSubtotalCents', value.printedSubtotalCents);
  const printedTotalCents = nullableCents('printedTotalCents', value.printedTotalCents);

  let tipSource: TipSource | null = null;
  if (value.tipSource !== null) {
    if (TIP_SOURCES.includes(value.tipSource as TipSource)) {
      tipSource = value.tipSource as TipSource;
    } else {
      errors.push(`tipSource must be one of ${TIP_SOURCES.join(', ')} or null`);
    }
  }

  let warnings: string[] = [];
  if (!Array.isArray(value.warnings) || !value.warnings.every((w) => typeof w === 'string')) {
    errors.push('warnings must be an array of strings');
  } else {
    warnings = value.warnings as string[];
  }

  if (errors.length > 0) return { ok: false, code: 'INVALID_OUTPUT', errors };

  return {
    ok: true,
    receipt: {
      isReceipt: value.isReceipt as boolean,
      merchantName: merchantName as string | null,
      currency,
      items,
      discountCents: value.discountCents as number,
      taxCents: value.taxCents as number,
      fees,
      printedTipCents,
      tipSource,
      printedSubtotalCents,
      printedTotalCents,
      warnings,
    },
  };
}
