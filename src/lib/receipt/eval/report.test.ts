import { sampleReceipt } from '../fixtures';
import { COST_DISCLAIMER, PRICING_SOURCE_URL, PRICING_TAKEN_ON } from './pricing';
import { comparisonTable, formatCost, formatRate, formatReport, formatSeconds, renderTable } from './report';
import { scoreReceipt } from './score';
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

const usage = { inputTokens: 3000, outputTokens: 1000 };
const scan = (model: string, fixture: string, receipt = sampleReceipt): ScanResult => ({
  fixture,
  model,
  errorCode: null,
  receipt,
  score: scoreReceipt(receipt, expected),
  firstItemMs: 1200,
  doneMs: 3400,
  usage,
  costMicroUsd: scanCostMicroUsd(model, usage),
});

const results: ScanResult[] = [
  scan('claude-haiku-4-5-20251001', 'diner'),
  scan('claude-haiku-4-5-20251001', 'ramen', { ...sampleReceipt, items: sampleReceipt.items.slice(0, 1), taxCents: 1 }),
  {
    ...scan('claude-sonnet-5', 'diner'),
  },
  {
    ...scan('claude-sonnet-5', 'ramen'),
    errorCode: 'UPSTREAM_ERROR',
    receipt: null,
    score: null,
    doneMs: null,
    usage: null,
    costMicroUsd: null,
  },
];
const models = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

describe('formatting', () => {
  it('formats seconds, cost, and rates, with a dash for unknown', () => {
    expect(formatSeconds(3400)).toBe('3.40 s');
    expect(formatSeconds(null)).toBe('-');
    expect(formatCost(8000)).toBe('$0.0080');
    expect(formatCost(null)).toBe('-');
    expect(formatRate({ passed: 5, total: 12 })).toBe('5/12 (42%)');
    expect(formatRate({ passed: 0, total: 0 })).toBe('-');
  });

  it('pads columns and right-aligns all but the first', () => {
    expect(renderTable(['a', 'bb'], [['xxx', '1']])).toBe('a    bb\n---  --\nxxx   1');
  });
});

describe('comparisonTable', () => {
  const table = comparisonTable(models.map((m) => summarizeModel(m, results)));

  it('has a column per model and a row per metric SPEC 7.7 lists', () => {
    const [header] = table.split('\n');
    expect(header).toContain('claude-haiku-4-5-20251001');
    expect(header).toContain('claude-sonnet-5');
    for (const label of [
      'Every item and price',
      'Item count',
      'Subtotal',
      'Tax',
      'Tip',
      'Total',
      'Currency',
      'time to first item, median / p90',
      'time to done, median / p90',
      'input tokens per scan',
      'output tokens per scan',
      'cost per scan',
    ]) {
      expect(table).toContain(label);
    }
  });

  it('shows the pass rates, timing, and cost side by side', () => {
    const row = (label: string) => table.split('\n').find((l) => l.startsWith(label)) ?? '';
    expect(row('Tax')).toMatch(/1\/2 \(50%\)\s+1\/2 \(50%\)/);
    expect(row('scans (failed)')).toMatch(/2 \(0\)\s+2 \(1\)/);
    expect(row('time to done')).toContain('3.40 s / 3.40 s');
    expect(row('cost per scan')).toMatch(/\$0\.0080\s+\$0\.0160/);
  });
});

describe('formatReport', () => {
  const report = formatReport({ results, models, stub: false, coverageNotes: ['Only 2 fixtures; SPEC 7.7 asks for at least 12.'] });

  it('has a per-receipt table for each model, with misses and errors marked', () => {
    expect(report).toMatch(/^claude-haiku-4-5-20251001$/m);
    expect(report).toMatch(/^ramen .*✗ -1 \+0/m);
    expect(report).toContain('ERROR UPSTREAM_ERROR');
  });

  it('carries the comparison, the coverage notes, and the cost currency warning with source and date', () => {
    expect(report).toContain('Comparison');
    expect(report).toContain('Only 2 fixtures');
    expect(report).toContain(COST_DISCLAIMER);
    expect(report).toContain(PRICING_SOURCE_URL);
    expect(report).toContain(PRICING_TAKEN_ON);
    expect(report).toContain('only as current as that file');
  });

  it('marks a stub run, and only a stub run', () => {
    expect(report).not.toContain('STUB RUN');
    expect(formatReport({ results, models, stub: true, coverageNotes: [] })).toContain('STUB RUN');
  });

  it('says when a model has no price on file', () => {
    const unpriced = formatReport({ results: [scan('claude-mystery', 'diner')], models: ['claude-mystery'], stub: false, coverageNotes: [] });
    expect(unpriced).toContain('No price on file for claude-mystery');
  });
});
