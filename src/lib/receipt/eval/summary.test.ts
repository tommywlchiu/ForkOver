import { MODEL_PRICES, PRICING_SOURCE_URL, PRICING_TAKEN_ON } from './pricing';
import { scoreReceipt } from './score';
import { sampleReceipt } from '../fixtures';
import { scanCostMicroUsd, summarizeModel } from './summary';
import type { ScanResult } from './types';

const expected = {
  currency: 'USD',
  items: sampleReceipt.items,
  discountCents: 500,
  taxCents: 300,
  fees: sampleReceipt.fees,
  printedTipCents: 400,
  printedSubtotalCents: 3595,
  printedTotalCents: 3995,
};

const ok = (model: string, over: Partial<ScanResult> = {}): ScanResult => ({
  fixture: 'a',
  model,
  errorCode: null,
  receipt: sampleReceipt,
  score: scoreReceipt(sampleReceipt, expected),
  firstItemMs: 1000,
  doneMs: 3000,
  usage: { inputTokens: 3000, outputTokens: 1000 },
  costMicroUsd: scanCostMicroUsd(model, { inputTokens: 3000, outputTokens: 1000 }),
  ...over,
});

const failed = (model: string): ScanResult => ({
  ...ok(model),
  errorCode: 'UPSTREAM_ERROR',
  receipt: null,
  score: null,
  firstItemMs: null,
  doneMs: null,
  usage: null,
  costMicroUsd: null,
});

describe('pricing file', () => {
  it('names its source and date, and prices both eval models', () => {
    expect(PRICING_SOURCE_URL).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(PRICING_TAKEN_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(MODEL_PRICES)).toEqual(expect.arrayContaining(['claude-haiku-4-5-20251001', 'claude-sonnet-5']));
  });
});

describe('scanCostMicroUsd', () => {
  it('is integer micro-dollars: 3000 in + 1000 out is $0.008 on Haiku 4.5 and $0.016 on Sonnet 5', () => {
    const usage = { inputTokens: 3000, outputTokens: 1000 };
    expect(scanCostMicroUsd('claude-haiku-4-5-20251001', usage)).toBe(8000);
    expect(scanCostMicroUsd('claude-sonnet-5', usage)).toBe(16000);
  });

  it('is null for a model with no price on file', () => {
    expect(scanCostMicroUsd('claude-mystery', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe('summarizeModel', () => {
  it('counts pass rates, treating a failed scan as failing every check', () => {
    const results = [ok('m'), ok('m', { score: scoreReceipt({ ...sampleReceipt, taxCents: 1 }, expected) }), failed('m')];
    const summary = summarizeModel('m', results);
    expect(summary.scans).toBe(3);
    expect(summary.failedScans).toBe(1);
    expect(summary.checks.taxMatch).toEqual({ passed: 1, total: 3 });
    expect(summary.checks.allMatch).toEqual({ passed: 1, total: 3 });
    expect(summary.checks.currencyMatch).toEqual({ passed: 2, total: 3 });
  });

  it('takes timing from finished scans only, as median and 90th percentile', () => {
    const results = [1000, 2000, 3000, 4000, 5000].map((doneMs) => ok('m', { doneMs, firstItemMs: doneMs / 10 }));
    results.push(failed('m'));
    const { doneMs, firstItemMs } = summarizeModel('m', results);
    expect(doneMs.median).toBe(3000);
    expect(doneMs.p90).toBeCloseTo(4600);
    expect(firstItemMs.median).toBe(300);
    expect(firstItemMs.p90).toBeCloseTo(460);
  });

  it('averages tokens and cost, and totals cost, over scans that have them', () => {
    const results = [
      ok('claude-sonnet-5'),
      ok('claude-sonnet-5', { usage: { inputTokens: 1000, outputTokens: 0 }, costMicroUsd: 2000 }),
      failed('claude-sonnet-5'),
    ];
    const s = summarizeModel('claude-sonnet-5', results);
    expect(s.meanInputTokens).toBe(2000);
    expect(s.meanOutputTokens).toBe(500);
    expect(s.meanCostMicroUsd).toBe(9000);
    expect(s.totalCostMicroUsd).toBe(18000);
  });

  it('only counts the model asked for, and reports nulls when nothing finished', () => {
    const s = summarizeModel('m', [ok('other'), failed('m')]);
    expect(s.scans).toBe(1);
    expect(s.doneMs).toEqual({ median: null, p90: null });
    expect(s.meanCostMicroUsd).toBeNull();
    expect(s.totalCostMicroUsd).toBeNull();
  });
});
