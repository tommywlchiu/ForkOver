import { sampleReceipt } from './fixtures';
import {
  findMisplacedPrices,
  flagMisplacedPrices,
  matchKey,
  nameStartsWith,
  rowAmounts,
  rowLabel,
  rowNames,
} from './rowCheck';
import type { ParsedLineItem, ParsedReceipt } from './schema';

const item = (name: string, lineTotalCents: number, quantity = 1): ParsedLineItem => ({ name, quantity, lineTotalCents });

const receiptWith = (currency: string, rows: string[], items: ParsedLineItem[]): ParsedReceipt => ({
  ...sampleReceipt,
  currency,
  rows,
  items,
  warnings: [],
});

/** fixtures/receipts/otaru-masazushi-jpy-long.jpg, row by row. お好みF prints no price. */
const otaruRows = [
  '生ビール中 1個 ¥600',
  'お好みF 1個',
  '朝獲れ大ボタン 1個 ¥1,780',
  '真いか 1個 ¥180',
  '大とろ 1個 ¥780',
  '軍艦海水うに 1個 ¥780',
  'サーモン 1個 ¥250',
  'さんま 1個 ¥250',
  'いくら 1個 ¥250',
  'こはだ 1個 ¥250',
  'さば 1個 ¥250',
];

/** The answer file's items. */
const otaruCorrect = [
  item('生ビール中', 600),
  item('朝獲れ大ボタン', 1780),
  item('真いか', 180),
  item('大とろ', 780),
  item('軍艦海水うに', 780),
  item('サーモン', 250),
  item('さんま', 250),
  item('いくら', 250),
  item('こはだ', 250),
  item('さば', 250),
];

/**
 * The row-shifted Sonnet 5 read recorded in PR #9 (its replay "D"): お好みF takes
 * the next row's ¥1,780, prices move between rows, and さば is dropped so the
 * items still add up to the printed ¥5,370.
 */
const otaruShifted = [
  item('生ビール中', 600),
  item('お好みF', 1780),
  item('朝獲れ大ボタン', 780),
  item('真いか', 180),
  item('大とろ', 780),
  item('軍艦海水うに', 250),
  item('サーモン', 250),
  item('さんま', 250),
  item('いくら', 250),
  item('こはだ', 250),
];

/**
 * PR #9's final-run shift as its description gives it: お好みF ¥1,780, 朝獲れ大ボタン
 * ¥180, 真いか ¥780, 軍艦海水うに ¥250, with the last two names merged so the count
 * and the sum still fit.
 */
const otaruShiftedFinalRun = [
  item('生ビール中', 600),
  item('お好みF', 1780),
  item('朝獲れ大ボタン', 180),
  item('真いか', 780),
  item('大とろ', 780),
  item('軍艦海水うに', 250),
  item('サーモン', 250),
  item('さんま', 250),
  item('いくら', 250),
  item('こはだ さば', 250),
];

const sum = (items: ParsedLineItem[]) => items.reduce((total, i) => total + i.lineTotalCents, 0);

describe('matchKey', () => {
  it('drops case, punctuation, and symbols, and keeps word breaks only between spaced words', () => {
    expect(matchKey('  Fat Tire (27 @3.75)  101.25')).toBe('fat tire 27 3 75 101 25');
    expect(matchKey('軍艦 海水うに 1個 ¥780')).toBe('軍艦海水うに1個780');
    expect(matchKey('ｵ好みＦ　1個')).toBe(matchKey('ｵ好みF 1個'));
    expect(matchKey('お好みF 1個')).toBe('お好みf 1個');
  });
});

describe('rowNames', () => {
  it('matches whole words in spaced scripts', () => {
    expect(rowNames(matchKey('Iced Tea 3.00'), matchKey('Tea'))).toBe(true);
    expect(rowNames(matchKey('Steak 25.00'), matchKey('Tea'))).toBe(false);
    expect(rowNames(matchKey('Teapot 25.00'), matchKey('Tea'))).toBe(false);
    expect(rowNames(matchKey('2 Beer 17.00'), matchKey('beer'))).toBe(true);
  });

  it('matches inside unspaced scripts and ignores spacing there', () => {
    expect(rowNames(matchKey('軍艦海水うに 1個 ¥780'), matchKey('軍艦 海水うに'))).toBe(true);
    expect(rowNames(matchKey('お好みF 1個'), matchKey('お好みF'))).toBe(true);
    expect(rowNames(matchKey('朝獲れ大ボタン 1個 ¥1,780'), matchKey('お好みF'))).toBe(false);
  });

  it('never matches an empty name', () => {
    expect(rowNames(matchKey('Coffee 2.95'), matchKey('***'))).toBe(false);
  });
});

describe('rowLabel and nameStartsWith', () => {
  it('keeps a row\'s words without its numbers', () => {
    expect(rowLabel('  Onion -Sauteed 1.00')).toBe('onion sauteed');
    expect(rowLabel('  2 @ 8.50        17.00')).toBe('');
    expect(rowLabel('490x 4  ¥1,960内')).toBe('');
    expect(rowLabel('お好みF 1個')).toBe('お好みf');
  });

  it('matches the parent row of an item whose name folds in its modifiers', () => {
    expect(nameStartsWith(matchKey('Veggie Burger + Avocado'), rowLabel('Veggie Burger 8.25'))).toBe(true);
    expect(nameStartsWith(matchKey('Veggie Burgers'), rowLabel('Veggie Burger 8.25'))).toBe(false);
    expect(nameStartsWith(matchKey('Veggie Burger'), rowLabel('8.25'))).toBe(false);
  });
});

describe('rowAmounts', () => {
  it('reads yen with grouping separators as whole yen', () => {
    expect(rowAmounts('朝獲れ大ボタン 1個 ¥1,780', 0)).toEqual({ all: [1, 1780], last: 1780 });
    expect(rowAmounts('お好みF 1個', 0)).toEqual({ all: [1], last: 1 });
  });

  it('reads decimal prices in cents and ignores quantities beside them', () => {
    expect(rowAmounts('2 Draft Beer 17.00', 2)).toEqual({ all: [1700], last: 1700 });
    expect(rowAmounts('35 cent Buffalo Wings (5 Wings) (3 @1 5.25', 2)).toEqual({ all: [525], last: 525 });
    expect(rowAmounts('Fat Tire (27 @3.75) 101.25', 2)).toEqual({ all: [375, 10125], last: 10125 });
    expect(rowAmounts('Sushi 12,50', 2).last).toBe(1250);
    expect(rowAmounts('Tasting menu 1.234,50', 2).last).toBe(123450);
  });

  it('reads whole numbers as whole units when a row prints no decimal price', () => {
    expect(rowAmounts('Beer 17', 2)).toEqual({ all: [1700], last: 1700 });
    expect(rowAmounts('Wine 1,780', 2).last).toBe(178000);
  });

  it('reads full-width digits and finds nothing in a row without numbers', () => {
    expect(rowAmounts('ラーメン ￥１，２００', 0).last).toBe(1200);
    expect(rowAmounts('(ごはん無し', 0)).toEqual({ all: [], last: null });
  });
});

describe('findMisplacedPrices', () => {
  it('passes a correct read of the otaru receipt, with its unpriced お好みF row', () => {
    expect(findMisplacedPrices(receiptWith('JPY', otaruRows, otaruCorrect))).toEqual([]);
  });

  it('flags the recorded otaru row shift that the subtotal check cannot see', () => {
    expect(sum(otaruShifted)).toBe(5370);
    expect(findMisplacedPrices(receiptWith('JPY', otaruRows, otaruShifted))).toEqual([
      'お好みF',
      '朝獲れ大ボタン',
      '軍艦海水うに',
    ]);
  });

  it('flags the otaru shift from the final eval run on PR #9', () => {
    expect(sum(otaruShiftedFinalRun)).toBe(5370);
    expect(findMisplacedPrices(receiptWith('JPY', otaruRows, otaruShiftedFinalRun))).toEqual([
      'お好みF',
      '朝獲れ大ボタン',
      '真いか',
      '軍艦海水うに',
    ]);
  });

  it('flags a price read differently from the row that names it', () => {
    const rows = ['35 cent Buffalo Wings (5 Wings) (3 @1 5.25', '@ 0.35 per Wings', 'Mac & Cheese 8.95'];
    const items = [item('35 cent Buffalo Wings (5 Wings)', 100, 3), item('Mac & Cheese', 895)];
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual(['35 cent Buffalo Wings (5 Wings)']);
    items[0] = item('35 cent Buffalo Wings (5 Wings)', 525, 3);
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual([]);
  });

  it('accepts priced modifiers folded into the item above them', () => {
    const rows = [
      'Steak Sandwich (3 @8.50) 25.50',
      'Steak Sandwich 8.50',
      '  Onion -Sauteed 1.00',
      'Grill Chicken Wrap (2 @7.75) 15.50',
      '  Avocado (2 @0.50) 1.00',
      'Veggie Burger 8.25',
      '  Avocado 1.00',
      '  Blue Cheese 0.75',
      'Guinness 5.75',
    ];
    const items = [
      item('Steak Sandwich', 2550, 3),
      item('Steak Sandwich Onion -Sauteed', 950),
      item('Grill Chicken Wrap Avocado', 1650, 2),
      item('Veggie Burger + Avocado + Blue Cheese', 1000),
      item('Guinness', 575),
    ];
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual([]);
  });

  it('accepts an indented priced modifier folded into the item above it without renaming it', () => {
    // fixtures/receipts/chipotle-fremont-takeout-modifier.jpg: the answer keeps
    // the item named "Chicken Bowl", folding only Guacamole's price into it.
    const rows = ['Chicken Bowl 11.35', '  Guacamole 2.95'];
    const items = [item('Chicken Bowl', 1430)];
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual([]);
  });

  it('never lets an unpriced row borrow the price of a line below it that the read dropped', () => {
    const rows = ['2 Draft Beer 17.00', 'Omakase F', 'Katsu 18.95'];
    const items = [item('Draft Beer', 1700, 2), item('Omakase F', 1895)];
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual(['Omakase F']);
  });

  it('does not let a modifier run into the next item', () => {
    const rows = ['Burger 12.00', 'Fries 4.00'];
    expect(findMisplacedPrices(receiptWith('USD', rows, [item('Burger', 1600), item('Fries', 400)]))).toEqual([
      'Burger',
    ]);
  });

  it('accepts a two-line item, a quantity line, and a unit price times the quantity', () => {
    const rows = ['Chicken Sandwich', '  2 @ 8.50        17.00', '2 Draft Beer 17.00', 'Coffee 4 @2.95', 'SODA TEA (2 @1.89) 3.78'];
    const items = [
      item('Chicken Sandwich', 1700, 2),
      item('Draft Beer', 1700, 2),
      item('Coffee', 1180, 4),
      item('SODA TEA', 378, 2),
    ];
    expect(findMisplacedPrices(receiptWith('USD', rows, items))).toEqual([]);
  });

  it('accepts notes and a price line printed under the item name', () => {
    // fixtures/receipts/kenmin-shokudo-okinawa-jpy.jpg as Sonnet 5 copied it.
    const rows = [
      '生姜焼き定食',
      '(ごはん無し)',
      '790x 1  ¥790内',
      '揚げ餃子',
      '490x 4  ¥1,960内',
      'Cランチ',
      '(ごはん無し)',
      '690x 1  ¥690内',
      '沖縄ちゃんぽん',
      '690x 1  ¥690内',
    ];
    const items = [
      item('生姜焼き定食(ごはん無し)', 790),
      item('揚げ餃子', 1960, 4),
      item('Cランチ', 690),
      item('沖縄ちゃんぽん', 690),
    ];
    expect(findMisplacedPrices(receiptWith('JPY', rows, items))).toEqual([]);
    items[3] = item('沖縄ちゃんぽん', 790);
    expect(findMisplacedPrices(receiptWith('JPY', rows, items))).toEqual(['沖縄ちゃんぽん']);
  });

  it('flags every item when the read has no rows', () => {
    expect(findMisplacedPrices(receiptWith('JPY', [], otaruCorrect))).toEqual(otaruCorrect.map((i) => i.name));
  });

  it('flags an item that no row names, because its price cannot be checked', () => {
    const rows = ['CHX SALAD 5.49'];
    expect(findMisplacedPrices(receiptWith('USD', rows, [item('Chicken Salad', 549)]))).toEqual(['Chicken Salad']);
  });

  it('flags an item whose row is missing from a short rows list', () => {
    expect(findMisplacedPrices(receiptWith('JPY', otaruRows.slice(0, -1), otaruCorrect))).toEqual(['さば']);
  });

  it('flags merged names, as at the bottom of the otaru read', () => {
    const merged = [...otaruCorrect.slice(0, -2), item('さば こはだ', 500)];
    expect(findMisplacedPrices(receiptWith('JPY', otaruRows, merged))).toEqual(['さば こはだ']);
  });

  it('accepts an item named on several rows when any of them prints its price', () => {
    const rows = ['Tea 2.50', 'Iced Tea 3.00'];
    expect(findMisplacedPrices(receiptWith('USD', rows, [item('Tea', 250), item('Iced Tea', 300)]))).toEqual([]);
  });
});

describe('flagMisplacedPrices', () => {
  it('returns the receipt unchanged when every price is on its own row', () => {
    const receipt = receiptWith('JPY', otaruRows, otaruCorrect);
    expect(flagMisplacedPrices(receipt)).toBe(receipt);
  });

  it('adds one warning naming every misplaced item, after the existing warnings', () => {
    const receipt = { ...receiptWith('JPY', otaruRows, otaruShifted), warnings: ['Thumb covers part of the receipt'] };
    expect(flagMisplacedPrices(receipt)).toEqual({
      ...receipt,
      warnings: [
        'Thumb covers part of the receipt',
        'Prices may be on the wrong lines. These items don\'t match the price printed on their own line on the receipt, or no line on the receipt matches them: "お好みF", "朝獲れ大ボタン", "軍艦海水うに". Check them against the receipt.',
      ],
    });
  });
});
