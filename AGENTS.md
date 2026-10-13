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
  policy for a normal client). It flushes anything built up locally (items, fees, named people,
  claims) with `upsert` (so re-flushing is always safe) and then re-reads the bill with
  `fetchSnapshot` rather than trusting its own writes - on any failure (the RPC, a flush write, or
  the read-back) it leaves the draft exactly as it was, still local-only, so a caller can retry.
  It's also safe under concurrency, both found and fixed after code review: a second concurrent
  `promoteBill` call for the same local id awaits the *same* in-flight attempt instead of starting
  its own (`create_manual_bill` has no idempotency key, so two real attempts would mint two
  separate, permanently orphaned bills); and an edit landing on the local id mid-flush is never
  lost - the flush loop compares a per-bill version counter before and after its await window and
  re-flushes with whatever's current if anything changed, rather than finalizing over it. Only on
  full, stable success does it rekey `bill.ts`'s `bills`/`renamedBillIds` so a screen still mounted
  on the old id keeps resolving. Every item/fee/person/claim gets a `crypto.randomUUID()` id up
  front so promotion never has to remap one a screen already rendered - only the bill's own id and
  the payer's person id change (the draft's payer id is the raw auth user id; the real one is
  `bill_people.id`, which claims reference, and `promoteBill` remaps it in every claim it flushes).
  A stale screen handler still holding a bill's pre-promotion local id (captured in a closure
  before `promoteBill` rekeyed the cache) redirects to the promoted bill via an alias map instead
  of throwing on that narrow race.
  `src/state/useResolvedBill.ts` is the one hook every bill screen uses for the rekey fallback,
  offline-disabling controls, a sync error or persistent "not synced" retry
  (`unsyncedBillIds`/`retrySync`), *and* the realtime subscribe-on-mount / refetch-on-reconnect
  lifecycle (SPEC 8.3) - its own `SyncStatusBanner` component (`src/components/`) is the one place
  the sync state actually renders. Add a new bill screen through both, not a hand-wired
  `s.bills[id]` read, copy-pasted JSX, and its own `useEffect`s, or it will silently skip them -
  code review on PR #31 found this same "fixed on one screen, not the other two" shape three
  separate times (the rekey fallback, offline gating, then realtime) before it got centralized.
  **`dataStore` (this module's own cache), not zustand, is the single source of truth**: every
  mutator reads its starting point from `dataStore` via `require(billId)`, so anything that writes
  a bill's state from outside this module - a realtime update, a reconnect refetch - has to go
  through `dataStore.replaceBill()` first (`src/state/bill.ts`'s `refresh()` is what then copies
  it into zustand, the same one-way flow every mutator already uses). Writing a realtime snapshot
  straight into zustand instead is exactly the bug this was: the data layer's cache never learns
  about it, so the next local edit of any kind reads the stale pre-update object, mutates it, and
  silently erases the realtime update on its way back out. Edits write through optimistically once
  promoted via the shared `writeThrough` helper (revert + `syncErrors` on failure); it tags each
  write with a per-field "channel" and generation counter so a slow, now-stale write's failure can
  never roll back a field a newer write already updated. A bill that's never promoted (every jest
  test driving `src/lib/receipt/standIn`, which never supplies a `billId`) stays local-only, same
  as the old in-memory store always behaved.
  `subscribeToBillChanges` (same module) wires realtime Postgres changes per bill, debounced and
  guarded so an older in-flight refetch can never overwrite a newer one's result
  (`createDebouncedLatestFetcher`, independently unit-tested since the mock realtime channel never
  actually fires in tests) - this requires every bill table to be in the `supabase_realtime`
  publication (`supabase/migrations/20261011000000_enable_bill_realtime.sql`; Realtime fans out
  nothing for a table that isn't, silently, so a new bill-scoped table needs the same migration
  treatment). The mock Supabase client (`src/data/__mocks__/supabaseClient.ts`) backs the bill
  tables and `create_manual_bill` with a tiny in-memory table/query-builder stand-in for exactly
  this (its table list imports the dependency-free `src/data/billTables.ts`, not
  `supabaseBillStore.ts` directly - that used to go through `supabaseBillStore.ts` ->
  `./supabaseClient`, which Jest resolves back to the mock itself, a circular import that silently
  left the list `undefined`) - real RLS is only ever proven against local Postgres
  (`supabase/tests/*.sql`).
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
- `public/.well-known/` (SPEC line 132) holds fixture `apple-app-site-association` and
  `assetlinks.json` files proving the serving mechanism only - every identifier inside
  them is a placeholder, see `public/.well-known/README.md` for exactly what's missing
  (web origin domain, Apple Team ID + `ios.bundleIdentifier`, EAS project + Android
  `package` + signing cert SHA256 fingerprints) and why real values can't be filled in
  yet. Expo Router's static web export passes `public/` through verbatim to `dist/`
  (confirmed with `npx expo export -p web`), and it's reachable with no redirect over
  plain HTTPS once served - but `apple-app-site-association` has no file extension, so
  extension-based static servers (`npx expo serve`, most others) serve it as
  `application/octet-stream` instead of the `application/json` Apple requires; whatever
  hosts the production web origin needs an explicit header override for that one path.
- `src/data/pushTokens.ts`'s `registerForPushNotifications` runs once per sign-in from
  `src/app/(app)/_layout.tsx` and upserts the device's Expo push token into `push_tokens` (SPEC
  8.1/8.7). It no-ops (web, simulators/emulators) and never throws; it also no-ops until an EAS
  project exists (no `projectId` configured yet in `app.json`/`eas.json`), which `notify` (a later
  M4 task) needs to actually send anything.
- `src/app/b/[token].tsx` (SPEC 4, native and web) is the public bill link: it never reads a bill
  by id, only by `share_token` (`bill.shareToken` on `StoredBill`, not `bill.id` - `share.tsx`'s
  link uses it too). Resolving a token has two paths in `supabaseBillStore.ts`: an already-member
  (including on a *closed* bill, SPEC 8.5) reads straight through `fetchBillByShareTokenIfMember`
  (plain RLS-gated select); everyone else goes through `joinBillByToken` (`join_bill`, SPEC 8.2),
  which unconditionally rejects a closed bill even for an idempotent rejoin, so it's only ever
  called once the first path has already come back empty. Claiming always acts for the resolved
  "self" person id; there is no person-switcher like the payer's bill screen (that's M5). A bill
  loaded this way (not through `promoteBill`) needs `BillStore.replaceBill` to also mark it
  promoted, or every claim write silently stays local-only - `loadBill` on `src/state/bill.ts` is
  the one call that does both the load and that marking.
- RN Web sizes an unconstrained `<Text>` to its own unwrapped content width before it will wrap,
  so centering it with only a shrink-to-fit flex parent (`alignItems: 'center'`) overflows a
  narrow screen instead of wrapping - give it (or a wrapping `View`) a real `width`, not just
  `textAlign: 'center'`. Also, RN Web's `Pressable` renders as `<button>`, not `<div role="button">`
  - a screenshot-driving script that queries by tag will silently find nothing.

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
