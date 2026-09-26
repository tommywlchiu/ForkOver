/** Plain-text report: a table per model, then the side-by-side comparison. */
import { COST_DISCLAIMER, MODEL_PRICES } from './pricing.ts';
import { CHECKS } from './score.ts';
import { summarizeModel, type ModelSummary, type Timing } from './summary.ts';
import type { ScanResult } from './types.ts';

/** Left-aligned first column, right-aligned the rest, columns padded to fit. */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...all.map((row) => [...row[col]].length)));
  const pad = (cell: string, col: number) => {
    const fill = ' '.repeat(widths[col] - [...cell].length);
    return col === 0 ? cell + fill : fill + cell;
  };
  const line = (row: readonly string[]) => row.map(pad).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const dash = '-';

export const formatSeconds = (ms: number | null): string => (ms === null ? dash : `${(ms / 1000).toFixed(2)} s`);

export const formatCost = (microUsd: number | null): string => (microUsd === null ? dash : `$${(microUsd / 1_000_000).toFixed(4)}`);

const formatTokens = (tokens: number | null): string => (tokens === null ? dash : String(Math.round(tokens)));

const formatTiming = (t: Timing): string => `${formatSeconds(t.median)} / ${formatSeconds(t.p90)}`;

export const formatRate = ({ passed, total }: { passed: number; total: number }): string =>
  total === 0 ? dash : `${passed}/${total} (${Math.round((passed * 100) / total)}%)`;

const mark = (ok: boolean) => (ok ? '✓' : '✗');

function receiptTable(model: string, results: readonly ScanResult[]): string {
  const header = ['receipt', ...CHECKS.filter((c) => c.key !== 'allMatch').map((c) => c.label), 'first item', 'done', 'in tok', 'out tok', 'cost'];
  const rows = results.map((r) => {
    if (r.score === null) {
      return [r.fixture, `ERROR ${r.errorCode ?? 'NO_RESULT'}`, ...CHECKS.filter((c) => c.key !== 'allMatch').map(() => dash), formatSeconds(r.firstItemMs), dash, dash, dash, dash];
    }
    const { score } = r;
    const cells = CHECKS.filter((c) => c.key !== 'allMatch').map(({ key }) => {
      if (key === 'itemsMatch' && !score.itemsMatch) return `✗ -${score.itemsMissing} +${score.itemsExtra}`;
      return mark(score[key]);
    });
    return [
      r.fixture,
      ...cells,
      formatSeconds(r.firstItemMs),
      formatSeconds(r.doneMs),
      formatTokens(r.usage?.inputTokens ?? null),
      formatTokens(r.usage?.outputTokens ?? null),
      formatCost(r.costMicroUsd),
    ];
  });
  return `${model}\n${renderTable(header, rows)}`;
}

/** The side-by-side table: one row per metric, one column per model. */
export function comparisonTable(summaries: readonly ModelSummary[]): string {
  const row = (label: string, cell: (s: ModelSummary) => string) => [label, ...summaries.map(cell)];
  const rows = [
    row('scans (failed)', (s) => `${s.scans} (${s.failedScans})`),
    ...CHECKS.map(({ key, label }) => row(label, (s) => formatRate(s.checks[key]))),
    row('time to first item, median / p90', (s) => formatTiming(s.firstItemMs)),
    row('time to done, median / p90', (s) => formatTiming(s.doneMs)),
    row('input tokens per scan (mean)', (s) => formatTokens(s.meanInputTokens)),
    row('output tokens per scan (mean)', (s) => formatTokens(s.meanOutputTokens)),
    row('cost per scan (mean)', (s) => formatCost(s.meanCostMicroUsd)),
    row('cost of this run (total)', (s) => formatCost(s.totalCostMicroUsd)),
  ];
  return renderTable(['', ...summaries.map((s) => s.model)], rows);
}

export type ReportInput = {
  results: readonly ScanResult[];
  models: readonly string[];
  /** True for a stub run: the numbers are not model results. */
  stub: boolean;
  /** Shortfalls against SPEC 7.7, from `coverageNotes`. */
  coverageNotes: readonly string[];
};

export function formatReport({ results, models, stub, coverageNotes }: ReportInput): string {
  const sections: string[] = [];
  if (stub) {
    sections.push('*** STUB RUN: answers came from a fake upstream that echoes each expected file. Nothing below measures a real model. ***');
  }
  if (coverageNotes.length > 0) sections.push(['Fixture set:', ...coverageNotes.map((n) => `  - ${n}`)].join('\n'));

  for (const model of models) {
    sections.push(receiptTable(model, results.filter((r) => r.model === model)));
  }

  const summaries = models.map((model) => summarizeModel(model, results));
  sections.push(`Comparison\n${comparisonTable(summaries)}`);

  const notes = [
    'A failed scan counts as failing every check. Timing is for scans that finished; tokens and cost only for scans that parsed.',
    'Times run from sending the photo to the first item event and to the done event, through the parse-receipt handler.',
    COST_DISCLAIMER,
  ];
  const unpriced = models.filter((m) => !(m in MODEL_PRICES));
  if (unpriced.length > 0) notes.push(`No price on file for ${unpriced.join(', ')}, so its cost shows "-".`);
  sections.push(notes.join('\n'));

  return `${sections.join('\n\n')}\n`;
}
