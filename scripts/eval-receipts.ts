/**
 * Receipt-reading eval (SPEC.md section 7.7). Runs every fixture in
 * fixtures/receipts/ through the parse-receipt handler for each model and prints
 * per-receipt results and a side-by-side comparison. See fixtures/receipts/README.md.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:receipts -- [model ...] [--dir <dir>] [--json <file>]
 *   npm run eval:receipts -- --stub        # no API key, no spend
 *
 * Models default to claude-haiku-4-5-20251001 and claude-sonnet-5. The key is
 * read from the environment only, and is never printed or written anywhere.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { coverageNotes } from '../src/lib/receipt/eval/expected.ts';
import { loadFixtures } from '../src/lib/receipt/eval/loadFixtures.ts';
import { formatReport, formatSeconds } from '../src/lib/receipt/eval/report.ts';
import { DEFAULT_MAX_IMAGE_BYTES, runEval } from '../src/lib/receipt/eval/run.ts';
import { builtinStubFixtures, stubFetchFor } from '../src/lib/receipt/eval/stub.ts';

const DEFAULT_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];
const DEFAULT_DIR = 'fixtures/receipts';

const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stub: { type: 'boolean', default: false },
    dir: { type: 'string', default: DEFAULT_DIR },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(
    'Usage: npm run eval:receipts -- [model ...] [--stub] [--dir <fixtures dir>] [--json <results file>]\n' +
      `Models default to: ${DEFAULT_MODELS.join(', ')}\n` +
      'Live runs need ANTHROPIC_API_KEY in the environment. --stub needs nothing.',
  );
  process.exit(0);
}

const models = positionals.length > 0 ? positionals : DEFAULT_MODELS;
const stub = values.stub === true;

const apiKey = stub ? 'stub-not-a-key' : (process.env.ANTHROPIC_API_KEY ?? '');
if (!apiKey) fail('ANTHROPIC_API_KEY is not set. Export it in your shell, or use --stub for a run that costs nothing.', 2);

const loaded = loadFixtures(resolve(values.dir));
if (loaded.problems.length > 0) fail(`Fixture problems:\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}`);

let fixtures = loaded.fixtures;
let usingBuiltins = false;
if (fixtures.length === 0) {
  if (!stub) fail(`No fixtures in ${values.dir}. See fixtures/receipts/README.md for the photo and expected-file format.`);
  fixtures = builtinStubFixtures();
  usingBuiltins = true;
  console.error(`No photos in ${values.dir}; stub mode is using ${fixtures.length} built-in in-memory cases.`);
}

const maxImageBytes = Number(process.env.MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
console.error(`Scanning ${fixtures.length} fixtures with ${models.join(', ')}${stub ? ' (stub)' : ''}...`);

const results = await runEval(
  fixtures,
  models,
  { apiKey, maxImageBytes, fetchFor: stub ? stubFetchFor : undefined },
  (r) => console.error(`  ${r.model}  ${r.fixture}  ${r.errorCode ?? 'ok'}  ${formatSeconds(r.doneMs)}`),
);

console.log(
  formatReport({ results, models, stub, coverageNotes: usingBuiltins ? [] : coverageNotes(fixtures) }),
);

if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ stub, models, results }, null, 2)}\n`);
  console.error(`Wrote ${values.json}`);
}
