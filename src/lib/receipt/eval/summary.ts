/** Turns per-scan results into the per-model aggregates the report tables show. */
import type { Usage } from '../anthropic.ts';
import { MODEL_PRICES } from './pricing.ts';
import { CHECKS, type CheckKey } from './score.ts';
import { mean, median, percentile } from './stats.ts';
import type { ScanResult } from './types.ts';

/**
 * Cost of one scan in integer micro-dollars. A price in USD per million tokens
 * equals micro-dollars per token, so the cost is a plain product. Null when the
 * model has no entry in pricing.ts.
 */
export function scanCostMicroUsd(model: string, usage: Usage): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return Math.round(usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok);
}

export type Timing = { median: number | null; p90: number | null };

export type ModelSummary = {
  model: string;
  scans: number;
  /** Scans that ended in an error instead of a parsed receipt. */
  failedScans: number;
  /** Failed scans count as failing every check. */
  checks: Record<CheckKey, { passed: number; total: number }>;
  firstItemMs: Timing;
  doneMs: Timing;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanCostMicroUsd: number | null;
  totalCostMicroUsd: number | null;
};

const timing = (values: number[]): Timing => ({ median: median(values), p90: percentile(values, 90) });

const present = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);

export function summarizeModel(model: string, all: readonly ScanResult[]): ModelSummary {
  const results = all.filter((r) => r.model === model);
  const checks = Object.fromEntries(
    CHECKS.map(({ key }) => [key, { passed: results.filter((r) => r.score?.[key] === true).length, total: results.length }]),
  ) as ModelSummary['checks'];
  const costs = present(results.map((r) => r.costMicroUsd));
  const usages = results.flatMap((r) => (r.usage ? [r.usage] : []));

  return {
    model,
    scans: results.length,
    failedScans: results.filter((r) => r.errorCode !== null).length,
    checks,
    firstItemMs: timing(present(results.map((r) => r.firstItemMs))),
    doneMs: timing(present(results.map((r) => r.doneMs))),
    meanInputTokens: mean(usages.map((u) => u.inputTokens)),
    meanOutputTokens: mean(usages.map((u) => u.outputTokens)),
    meanCostMicroUsd: mean(costs),
    totalCostMicroUsd: costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null,
  };
}
