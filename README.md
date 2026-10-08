# ForkOver

A fast bill splitter for friend groups: the payer scans the receipt, AI reads the items, everyone
claims what they had, and every share adds up to the receipt total to the cent.

1. The payer snaps the receipt; the items stream in as the model reads them.
2. The payer reviews, adds the tip, and shares a link or QR code.
3. Everyone taps what they had, in the iOS/Android app or in a browser, with no account needed.
4. Everyone sees their total, and repays the payer through a prefilled Venmo link.

The product rationale is in [`docs/PRD.md`](docs/PRD.md); the build contract (architecture, split
math, schema, milestones) is in [`SPEC.md`](SPEC.md).

## Status

Early development. The payer screens (sign-in, scan, review, share, bill) run on one phone with local data,
a stand-in sign-in, and a stand-in receipt reader; the Supabase backend, Apple/Google sign-in, and live
parsing are not wired in yet.

| Milestone | State |
| --- | --- |
| **M1** Pure logic: split, claims, balance, money, Venmo links | Done |
| **M2** Receipt parsing: structured output schema, streaming `parse-receipt` function, reconciliation, model eval | Done. Signed off 2026-09-27: Sonnet 5 read 10 of 15 real receipts fully right, every total right, and every genuine misread was flagged by the review checks. See [`SPEC.md` section 11](SPEC.md#11-milestones) for detail |
| **M3** Payer app on one phone | Screens built on local data with stand-ins; Supabase, real sign-in, and live parsing pending |
| **M4** Shared bills (realtime, web claim page, guests) | Not started |
| **M5** Payer controls (assignment, paid marks, balances, closing) | Not started |
| **M6** Pro subscriptions and store launch | Not started |

Milestone detail is in [`SPEC.md` section 11](SPEC.md#11-milestones).

## Tech stack

- Expo SDK 57 with Expo Router, React Native, TypeScript (strict). One codebase for iOS, Android,
  and the web claim page.
- Supabase: Auth, Postgres with row-level security, Realtime, Storage, and Edge Functions (Deno).
- Anthropic Messages API for receipt parsing, called only from the `parse-receipt` Edge Function.
- Jest (`jest-expo`) for tests. All money math uses integer minor units.

## Repo layout

```
src/app/                    Expo Router routes: payer screens (auth, scan, review, share, bill)
src/lib/                    Pure, tested logic: split, claims, balance, money, pay, receipt
src/data/, src/state/       Local bill store, receipt reader seam, zustand stores used by screens
supabase/functions/         Edge Functions (parse-receipt); thin wiring over src/lib
fixtures/receipts/          Receipt eval fixtures (photos + expected JSON)
scripts/eval-receipts.ts    Model comparison eval
docs/PRD.md, SPEC.md        Product requirements and build spec
```

## Getting started

Requires Node.js and npm. Then:

```sh
npm install
npm start          # Expo dev server; or npm run ios / npm run android / npm run web
```

Checks:

```sh
npm test           # jest, scoped to src/
npm run typecheck  # tsc --noEmit
npm run lint       # expo lint
```

GitHub Actions runs these three checks on every pull request and push to `master`.

### Run `parse-receipt` locally

Needs Docker. Copy the env template and fill in `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` is preset;
the file is git-ignored; never put these in client code):

```sh
cp supabase/functions/parse-receipt/.env.example supabase/functions/.env.local
npx supabase start
npx supabase functions serve --env-file supabase/functions/.env.local
```

### Receipt eval

The eval runs each fixture through the parser with each model and prints an accuracy, latency, and
cost comparison. Try the no-spend, no-API-key stub run first (its accuracy numbers are meaningless):

```sh
npm run eval:receipts -- --stub
npm run eval:receipts -- --help
```

A live run spends real API credit:

```sh
ANTHROPIC_API_KEY=<your key> npm run eval:receipts
```

Fixture format, options, and scoring rules are in
[`fixtures/receipts/README.md`](fixtures/receipts/README.md).
