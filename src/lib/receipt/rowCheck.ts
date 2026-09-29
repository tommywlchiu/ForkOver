/**
 * The row check (SPEC 7.5): every item's price must be printed on the receipt
 * row that names it. The model copies each printed row of the item area into
 * `rows`, priced or not, and the prices are read back out of that same text
 * here, so a price the model moved onto another row's name shows up as a
 * mismatch. The sum checks in `reconcile.ts` cannot see that kind of error:
 * the prices still add up to the printed subtotal.
 *
 * This file is imported by the parse-receipt Edge Function (Deno), so it must
 * stay dependency-free and use explicit `.ts` imports.
 */
import { currencyExponent } from '../money/currency.ts';
import type { ParsedReceipt } from './schema.ts';

/** Letters and digits of scripts that put spaces between words. */
const SPACED = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{Nd}';
const STARTS_SPACED = new RegExp(`^[${SPACED}]`, 'u');
const ENDS_SPACED = new RegExp(`[${SPACED}]$`, 'u');

/**
 * Text reduced for name matching: NFKC, lower case, punctuation and symbols
 * removed. Spaces stay only between two words of a spaced script, so "Iced
 * Tea" keeps its word boundary while "軍艦 海水うに" and "軍艦海水うに" match.
 */
export function matchKey(text: string): string {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
  let key = '';
  for (const word of words) {
    if (ENDS_SPACED.test(key) && STARTS_SPACED.test(word)) key += ' ';
    key += word;
  }
  return key;
}

/** True when `name` appears in `row` as whole words (both are match keys). */
export function rowNames(row: string, name: string): boolean {
  if (name === '') return false;
  for (let at = row.indexOf(name); at !== -1; at = row.indexOf(name, at + 1)) {
    const cutBefore = !(ENDS_SPACED.test(row.slice(0, at)) && STARTS_SPACED.test(name));
    const cutAfter = !(STARTS_SPACED.test(row.slice(at + name.length)) && ENDS_SPACED.test(name));
    if (cutBefore && cutAfter) return true;
  }
  return false;
}

/** True when `name` begins with the whole words of `label` (both are match keys). */
export function nameStartsWith(name: string, label: string): boolean {
  if (label === '' || !name.startsWith(label)) return false;
  return !(ENDS_SPACED.test(label) && STARTS_SPACED.test(name.slice(label.length)));
}

/**
 * True when a row's own printed layout marks it as subordinate to the row
 * above: indented, or led by "+". A fold (SPEC 7.4) can rename the parent
 * item without folding the modifier's words into it (an item can just stay
 * "Chicken Bowl" over an indented "Guacamole" row), so the row check cannot
 * rely on name matching alone to tell a modifier's row from another item's.
 */
export function isSubordinateRow(row: string): boolean {
  return /^[ \t]|^\+/.test(row);
}

const NUMBER = /\d+(?:[.,']\d+)*/g;

/**
 * A row's words without its numbers or one-letter marks, as a match key:
 * "Onion -Sauteed 1.00" gives "onion sauteed", and a price line such as
 * "490x 4 ¥1,960内" or "2 @ 8.50 17.00" gives "".
 */
export function rowLabel(row: string): string {
  const words = row
    .normalize('NFKC')
    .replace(NUMBER, ' ')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => [...word].length > 1);
  return matchKey(words.join(' '));
}

/**
 * The amounts printed on a row, in minor units, in the order printed, and the
 * rightmost one. A number reads as a decimal price when the digits after its
 * last separator fit the currency ("17.00", "12,50"), otherwise as whole units
 * ("1,780" yen). In a currency with minor units, a row that prints any decimal
 * price keeps only those, so quantities such as "(3 @1" are not read as prices;
 * a row with none ("Beer 17") keeps its whole numbers.
 */
export function rowAmounts(row: string, exponent: number): { all: number[]; last: number | null } {
  const decimal: number[] = [];
  const whole: number[] = [];
  for (const [token] of row.normalize('NFKC').matchAll(NUMBER)) {
    const digits = Number(token.replace(/\D/g, ''));
    const lastSeparator = token.search(/[.,'](?=\d+$)/);
    const decimals = lastSeparator === -1 ? 0 : token.length - lastSeparator - 1;
    if (decimals > 0 && decimals <= exponent) decimal.push(digits * 10 ** (exponent - decimals));
    else whole.push(digits * 10 ** exponent);
  }
  const all = (decimal.length > 0 ? decimal : whole).filter(Number.isSafeInteger);
  return { all, last: all.at(-1) ?? null };
}

/**
 * Names of the items whose price is not printed on a row that names them.
 *
 * An item's own rows are those whose text contains its name, or whose words
 * begin it (the parent row of an item whose name folds in its modifiers). Each
 * is checked together with the rows just below it that belong to the same item:
 * a price line with no words (the second line of a two-line item), a priced
 * modifier whose words are in the item's name, a note with no price, or a row
 * that is itself printed as subordinate (indented, or led by "+") even when
 * its words never made it into the item's name. A row that names another
 * item ends the run regardless, so an unpriced or subordinate-looking row can
 * never borrow the price of an unrelated item below it.
 *
 * The item passes when its line total is an amount printed in that run, a unit
 * price there times its quantity, or the running sum of the run's rightmost
 * amounts (a parent plus its modifiers). An item that no row names (a renamed
 * or merged line, or a read whose rows are empty or short) cannot be checked,
 * so it fails too.
 */
export function findMisplacedPrices(receipt: Pick<ParsedReceipt, 'currency' | 'rows' | 'items'>): string[] {
  const exponent = currencyExponent(receipt.currency);
  const rowKeys = receipt.rows.map(matchKey);
  const labels = receipt.rows.map(rowLabel);
  const amounts = receipt.rows.map((row) => rowAmounts(row, exponent));
  const itemKeys = receipt.items.map((item) => matchKey(item.name));
  const namesAnItem = rowKeys.map((row) => itemKeys.some((name) => rowNames(row, name)));

  const priceFits = (anchor: number, name: string, lineTotal: number, quantity: number): boolean => {
    let runningSum = 0;
    for (let row = anchor; row < rowKeys.length; row++) {
      const belongs =
        labels[row] === '' ||
        rowNames(name, labels[row]) ||
        amounts[row].all.length === 0 ||
        isSubordinateRow(receipt.rows[row]);
      if (row > anchor && (namesAnItem[row] || !belongs)) break;
      if (amounts[row].all.some((amount) => amount === lineTotal || amount * quantity === lineTotal)) return true;
      runningSum += amounts[row].last ?? 0;
      if (runningSum === lineTotal) return true;
    }
    return false;
  };

  const misplaced: string[] = [];
  receipt.items.forEach((item, index) => {
    const name = itemKeys[index];
    const anchors = rowKeys.flatMap((row, at) =>
      rowNames(row, name) || nameStartsWith(name, labels[at]) ? [at] : [],
    );
    if (!anchors.some((at) => priceFits(at, name, item.lineTotalCents, item.quantity))) {
      misplaced.push(item.name);
    }
  });
  return misplaced;
}

/** Adds one review-screen warning naming every item that fails the row check. */
export function flagMisplacedPrices(receipt: ParsedReceipt): ParsedReceipt {
  const misplaced = findMisplacedPrices(receipt);
  if (misplaced.length === 0) return receipt;
  const names = misplaced.map((name) => `"${name}"`).join(', ');
  return {
    ...receipt,
    warnings: [
      ...receipt.warnings,
      `Prices may be on the wrong lines. These items don't match the price printed on their own line on the receipt, or no line on the receipt matches them: ${names}. Check them against the receipt.`,
    ],
  };
}
