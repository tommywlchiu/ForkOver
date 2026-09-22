/** Small statistics helpers for the eval report. */

/**
 * The `p`th percentile (0 to 100) by linear interpolation between the closest
 * ranks, so `percentile(v, 50)` is the usual median. Null for no values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
