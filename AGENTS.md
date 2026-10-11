# ForkOver

A fast bill splitter for friend groups: the payer scans the receipt, AI reads the items, everyone
claims what they had, and every share adds up to the receipt to the cent.

`SPEC.md` is the build contract and `docs/PRD.md` is the product rationale. Read the relevant
section of SPEC.md before starting a milestone.

## Expo

Expo has changed. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing app code. Routes live under `src/app/`, not a top-level `app/`.

## App architecture (payer app, M3+)

- `src/data/localBillStore.ts` defines the `BillStore` interface and an in-memory implementation
  (still used by its own tests); `src/data/supabaseBillStore.ts` (M4) is the real one `src/state/
  bill.ts` wraps, calling `src/lib/claims` + `src/lib/split` for derived state. A draft bill still
  mints a local id synchronously so screens can navigate immediately; `promoteBill` is the one
  place that gets reconciled to the real server id - adopted from `parse-receipt`'s `done` event
  for a scan, or minted by the `create_manual_bill` RPC for manual entry (`bills` has no INSERT
  policy for a normal client) - flushing anything built up locally and rekeying `bill.ts`'s
  `bills`/`renamedBillIds` so a screen still mounted on the old id keeps resolving. Every item/
  fee/person gets a `crypto.randomUUID()` id up front so promotion never has to remap one a screen
  already rendered. Edits write through optimistically once promoted (revert + `syncErrors` on
  failure); a bill that's never promoted (every jest test driving `src/lib/receipt/standIn`, which
  never supplies a `billId`) stays local-only, same as the old in-memory store always behaved.
  `subscribeToBillChanges` (same module) wires realtime Postgres changes per bill; the native bill
  screen subscribes on mount and refetches on reconnect (`useConnectivityStore`). The mock
  Supabase client (`src/data/__mocks__/supabaseClient.ts`) backs the bill tables and
  `create_manual_bill` with a tiny in-memory table/query-builder stand-in for exactly this - real
  RLS is only ever proven against local Postgres (`supabase/tests/*.sql`).
- `src/data/receiptReader.ts` is the one place a screen gets a receipt reader. It POSTs the image
  to the real `parse-receipt` Edge Function with the signed-in user's bearer token
  (`supabase.auth.getSession()`) and adapts its NDJSON `WireEvent` stream (handler.ts) into
  `ParseEvent` (`parseReceipt.ts`); the two `done` shapes differ (`billId` vs `usage`), so both are
  optional on `ParseEvent`. Uses `expo/fetch` by name: Expo SDK 57 installs it as the global fetch
  on native specifically because RN's built-in fetch has historically not streamed response bodies
  there. Tests fully mock this module (see `src/integration/paymentFlow.test.tsx`) and instead
  drive `src/lib/receipt/standIn/`, which replays a canned `ParsedReceipt` (`scenarios.ts`) through
  the same event-stream shape.
- `src/state/session.ts` backs the session with real Supabase Auth (Google only; Apple is deferred
  to M6). `src/data/supabaseClient.ts` is the one Supabase client; session persistence uses
  `expo-sqlite`'s `localStorage` polyfill (Expo's current guidance for SDK 57+), not
  `@react-native-async-storage/async-storage`. `signIn()` is async (it opens a browser and awaits
  the `forkover://` redirect) and `onAuthStateChange` keeps the store in sync across restarts.
  Jest tests mock `../data/supabaseClient` with `src/data/__mocks__/supabaseClient.ts`, a fake
  Auth + `profiles` table; see `src/state/session.test.ts` and the integration tests for the
  pattern (also mocking `expo-web-browser`'s `openAuthSessionAsync`).
- `REALISTIC_RECEIPT` in `src/lib/receipt/standIn/scenarios.ts` mirrors `split.test.ts`'s "realistic
  receipt" worked example (payer a, b owes 3599, c owes 2253); claiming it the same way through the
  Bill screen reproduces those exact totals, which is what `src/integration/paymentFlow.test.tsx`
  and `scripts/measure-scan-latency.ts` both rely on.
- `src/data/pushTokens.ts`'s `registerForPushNotifications` runs once per sign-in from
  `src/app/(app)/_layout.tsx` and upserts the device's Expo push token into `push_tokens` (SPEC
  8.1/8.7). It no-ops (web, simulators/emulators) and never throws; it also no-ops until an EAS
  project exists (no `projectId` configured yet in `app.json`/`eas.json`), which `notify` (a later
  M4 task) needs to actually send anything.

## Working rules

- Money is integer minor units everywhere except the final render. No floats in math.
- Pure logic lives in `src/lib` with tests. Screens, stores, and the web page call it; they never
  reimplement it.
- Never modify expectations in `src/lib/split/split.test.ts` or `src/lib/claims/resolve.test.ts`.
- Every schema change is a migration in `supabase/migrations/`. Every table has RLS enabled, and
  every policy has a pgTAP test.
- Every interactive element gets a stable kebab-case `testID` (for example `claim-item-<id>`,
  `share-item-<id>`, `person-row-<id>`, `looks-right-button`) so automation can tap it.
- Add dependencies only with `npx expo install`.
- No secrets in client code or `EXPO_PUBLIC_` variables.
- Before saying a task is done: run tests, typecheck, lint, and screenshot the affected screens on
  both platforms (and the web for claim routes).
- When blocked or unsure about product behavior, stop and ask instead of guessing.

## Commands

```sh
npm test                     # jest-expo, scoped to src/
npm run typecheck            # tsc --noEmit
npm run lint                 # expo lint
npm run measure:scan-latency # median shutter-to-sent over N stand-in runs (SPEC 8.8)
```

- `@testing-library/react-native` is pinned to `^13.3.3`, not 14+: expo-router 57's
  `renderRouter`/testing-library helper (`expo-router/testing-library`) calls `jest.useFakeTimers()`
  and expects the old synchronous `render`/`fireEvent`. RNTL 14 made both async internally, which
  silently never resolves under those fake timers (`screen` queries throw "render function has not
  been called" forever). `@react-native/jest-preset` must stay an explicit devDependency too;
  jest-expo's preset requires it directly rather than finding it transitively.
- Every `fireEvent.*` call in RNTL 13 is still synchronous; component/integration tests use
  `expo-router/testing-library`'s `renderRouter` + `screen`/`fireEvent`/`waitFor`, driving screens by
  the `testID`s above (see `src/integration/paymentFlow.test.tsx`).
- This sandbox's `chrome-devtools-axi` cannot launch a browser (missing system libraries, e.g.
  `libnspr4.so`, the same gap `expo start`'s react-native-devtools install warns about) and there are
  no iOS/Android simulators here either. If both are still true, verify screens with `npm test` and
  `expo start --web` output instead of screenshots, and say so plainly rather than claiming
  screenshots that don't exist.

## Edge Functions

- `supabase/functions/*/index.ts` is thin Deno wiring. The logic lives in `src/lib` so jest tests it; `tsc` and eslint skip `supabase/functions`.
- Files that Deno imports (`src/lib/receipt/{schema,partialJson,prompt,anthropic,parseReceipt,rowCheck,handler}.ts` and `src/lib/money/currency.ts`) import each other with explicit `.ts` extensions and no dependencies. Keep it that way.
- `supabase start` and `supabase functions serve` need Docker (WSL integration enabled). The CLI is a dev dependency: `npx supabase ...`.
- Secrets live in `supabase/functions/.env.local` (git-ignored, template in `.env.example`), never in client code.
- `parse-receipt/ports.ts` exports `createDataPorts(supabase)`, a factory over the one service-role
  client `index.ts` already creates (not a second client). It is the only code that reads or writes
  `bills`, `scan_usage`, and `scan_log`: each has RLS enabled with zero policies, so `anon`/
  `authenticated` are denied by default until a later milestone adds real policies. Verify any
  change to these tables or `ports.ts` against local Docker (`npx supabase db reset`, `npx supabase
  test db --local`); ports.ts itself has no jest coverage (same reason as other Deno-imported
  files), so exercise it directly against the local stack before trusting it.

## Receipt eval

- `npm run eval:receipts -- --stub` runs the eval pipeline with no API key. Live runs, fixture format, and the scoring rules are in `fixtures/receipts/README.md`; the code is `scripts/eval-receipts.ts` and `src/lib/receipt/eval/`.
- The script (and `scripts/measure-scan-latency.ts`) runs under Node's `--experimental-transform-types`, so everything it imports must use explicit `.ts` import extensions and no `enum`s. Files that import extensionlessly (`reconcile`, `toBill`) cannot be used from either.
- Committed receipt photos must be licensed for public use and listed in `fixtures/receipts/ATTRIBUTION.md`. Anything else goes in the git-ignored `fixtures/receipts-local/` (run with `--dir`).
- Cost figures come from `src/lib/receipt/eval/pricing.ts`. Update it when prices or the eval models change.
- `ANTHROPIC_API_KEY` is read from the environment only. Never print, log, or write it.

## How changes land

- Work is dispatched by the first mate (`.claude/firstmate.md`). Each change is made in its own git
  worktree under `.claude/worktrees/`, on an `fm/<task>` branch, and lands as a squash-merged PR once
  CI passes and the owner approves. Nobody commits to `master` directly.
- A fresh worktree has no `node_modules`; run `npm ci` before anything else.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
