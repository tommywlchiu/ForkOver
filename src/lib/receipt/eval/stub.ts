/**
 * Stub mode: answers each scan from a fake Anthropic stream, so the whole
 * pipeline (handler, streaming parse, scoring, report) can run with no API key
 * and no spend. The stub "model" reads the fixture's own expected answer back,
 * so its accuracy figures say nothing about any real model.
 */
import { chunkText, mockAnthropicFetch } from '../mockAnthropic.ts';
import type { ParsedReceipt } from '../schema.ts';
import { sampleReceipt } from '../fixtures.ts';
import type { ExpectedReceipt } from './expected.ts';
import type { EvalFixture } from './types.ts';

/** The receipt a perfect model would return for `expected`. */
export function receiptFromExpected(expected: ExpectedReceipt): ParsedReceipt {
  return {
    isReceipt: true,
    merchantName: 'Stub Merchant',
    currency: expected.currency,
    items: expected.items,
    discountCents: expected.discountCents,
    taxCents: expected.taxCents,
    fees: expected.fees,
    printedTipCents: expected.printedTipCents,
    tipSource: expected.printedTipCents ? 'printed' : null,
    printedSubtotalCents: expected.printedSubtotalCents,
    printedTotalCents: expected.printedTotalCents,
    warnings: [],
  };
}

/** A `fetchFor` for `EvalOptions`: a stub upstream that returns the fixture's expected receipt. */
export function stubFetchFor(fixture: EvalFixture): typeof fetch {
  const text = JSON.stringify(receiptFromExpected(fixture.expected));
  return mockAnthropicFetch({
    textChunks: chunkText(text, 24),
    usage: { inputTokens: 1500, outputTokens: Math.ceil(text.length / 4) },
  }).fetch;
}

const fakeImage = new TextEncoder().encode('stub image, not a real photo');

/** Two in-memory cases for a stub run when `fixtures/receipts/` has no photos yet. Never written to disk. */
export function builtinStubFixtures(): EvalFixture[] {
  return [
    {
      name: 'stub-usd',
      image: fakeImage,
      mediaType: 'image/jpeg',
      kinds: [],
      expected: {
        currency: sampleReceipt.currency,
        items: sampleReceipt.items,
        discountCents: sampleReceipt.discountCents,
        taxCents: sampleReceipt.taxCents,
        fees: sampleReceipt.fees,
        printedTipCents: sampleReceipt.printedTipCents,
        printedSubtotalCents: sampleReceipt.printedSubtotalCents,
        printedTotalCents: sampleReceipt.printedTotalCents,
      },
    },
    {
      name: 'stub-jpy',
      image: fakeImage,
      mediaType: 'image/png',
      kinds: [],
      expected: {
        currency: 'JPY',
        items: [
          { name: 'Ramen', quantity: 2, lineTotalCents: 1800 },
          { name: 'Gyoza', quantity: 1, lineTotalCents: 450 },
        ],
        discountCents: 0,
        taxCents: 225,
        fees: [],
        printedTipCents: null,
        printedSubtotalCents: 2250,
        printedTotalCents: 2475,
      },
    },
  ];
}
