/**
 * Reports the median shutter-to-sent time over N stand-in fixture scans
 * (SPEC.md section 11, M3 checkpoint: "Report the median shutter-to-sent
 * time over 10 fixture runs").
 *
 * This measures the stand-in reader (src/lib/receipt/standIn), which
 * replays a canned receipt with the same streaming delays the review screen
 * sees, plus the negligible synchronous cost of confirming the review and
 * sending. It does NOT measure live AI parsing, network latency, or a human
 * actually reviewing the bill — those only exist once the real backend and
 * a live model are wired in (SPEC.md section 11 lists that as a later part).
 *
 *   npm run measure:scan-latency -- [--runs <n>]
 */
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createLocalAnalytics } from '../src/lib/analytics/analytics.ts';
import { createStandInReader, DEFAULT_STAND_IN_DELAYS } from '../src/lib/receipt/standIn/standInReader.ts';
import { REALISTIC_RECEIPT } from '../src/lib/receipt/standIn/scenarios.ts';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '10' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage: npm run measure:scan-latency -- [--runs <n>]\nDefaults to 10 runs of the stand-in reader.');
  process.exit(0);
}

const runs = Number.parseInt(values.runs ?? '10', 10);
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer, got "${values.runs}"`);
  process.exit(1);
}

async function runOnce(analytics: ReturnType<typeof createLocalAnalytics>): Promise<void> {
  analytics.record('scan_shutter');

  const reader = createStandInReader(REALISTIC_RECEIPT, DEFAULT_STAND_IN_DELAYS);
  let firstItemSeen = false;
  for await (const event of reader()) {
    if (event.type === 'item' && !firstItemSeen) {
      firstItemSeen = true;
      analytics.record('parse_first_item');
    } else if (event.type === 'done') {
      analytics.record('parse_done', { itemCount: event.receipt.items.length });
    }
  }

  // "Looks right" and sending are near-instant taps once items have streamed
  // in; the stand-in reader's replay delay is the whole point being measured.
  analytics.record('review_confirmed');
  analytics.record('bill_sent');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  // The events still get recorded (SPEC 8.8), but the reported durations come
  // from a monotonic clock: under WSL2, Date.now() can briefly jump backward
  // on a clock-sync correction, which would occasionally show as a negative
  // "shutter to sent" delta for whichever run happens to straddle it.
  const analytics = createLocalAnalytics('measure-scan-latency');
  const perRunMs: number[] = [];

  for (let i = 0; i < runs; i++) {
    const before = performance.now();
    await runOnce(analytics);
    perRunMs.push(Math.round(performance.now() - before));
  }

  console.log(`Stand-in shutter-to-sent latency over ${runs} runs (fixture: "${REALISTIC_RECEIPT.merchantName}"):`);
  perRunMs.forEach((ms, i) => console.log(`  run ${i + 1}: ${ms} ms`));
  console.log(`\nMedian: ${median(perRunMs)} ms`);
  console.log(`(${analytics.events().length} SPEC 8.8 analytics events recorded across ${runs} runs.)`);
  console.log(
    '\nNote: this measures the stand-in reader replaying a canned receipt, not live AI parsing ' +
      '(no network call or API key involved). Live-parse latency will be reported once the real ' +
      'parse-receipt backend is wired in.',
  );
}

main();
