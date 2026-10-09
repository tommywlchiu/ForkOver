# ForkOver

A fast bill splitter for friend groups: the payer scans the receipt, AI reads the items, everyone
claims what they had, and every share adds up to the receipt to the cent.

`SPEC.md` is the build contract and `docs/PRD.md` is the product rationale. Read the relevant
section of SPEC.md before starting a milestone.

## Expo

Expo has changed. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing app code. Routes live under `src/app/`, not a top-level `app/`.

## App architecture (payer app, M3+)

- `src/data/localBillStore.ts` defines the `BillStore` interface and today's in-memory
  implementation; `src/state/bill.ts` is the zustand store screens use, wrapping it and calling
  `src/lib/claims` + `src/lib/split` for derived state. Swapping in Supabase later means replacing
  the implementation behind `BillStore`, not the screens or the zustand store's shape.
- `src/data/receiptReader.ts` is the one place a screen gets a receipt reader. It currently always
  returns the stand-in reader (`src/lib/receipt/standIn/`), which replays a canned `ParsedReceipt`
  (`scenarios.ts`) through the same event-stream shape `parseReceiptImage` will produce; wiring in
  the real `parse-receipt` Edge Function is a one-function change in that file.
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
