# ForkOver

A fast bill splitter for friend groups: the payer scans the receipt, AI reads the items, everyone
claims what they had, and every share adds up to the receipt to the cent.

`SPEC.md` is the build contract and `docs/PRD.md` is the product rationale. Read the relevant
section of SPEC.md before starting a milestone.

## Expo

Expo has changed. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing app code. Routes live under `src/app/`, not a top-level `app/`.

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
npm test          # jest-expo, scoped to src/
npm run typecheck # tsc --noEmit
npm run lint      # expo lint
```

## Edge Functions

- `supabase/functions/*/index.ts` is thin Deno wiring. The logic lives in `src/lib` so jest tests it; `tsc` and eslint skip `supabase/functions`.
- Files that Deno imports (`src/lib/receipt/{schema,partialJson,prompt,anthropic,parseReceipt,handler}.ts`) import each other with explicit `.ts` extensions and no dependencies. Keep it that way.
- `supabase start` and `supabase functions serve` need Docker (WSL integration enabled). The CLI is a dev dependency: `npx supabase ...`.
- Secrets live in `supabase/functions/.env.local` (git-ignored, template in `.env.example`), never in client code.

## Receipt eval

- `npm run eval:receipts -- --stub` runs the eval pipeline with no API key. Live runs, fixture format, and the scoring rules are in `fixtures/receipts/README.md`; the code is `scripts/eval-receipts.ts` and `src/lib/receipt/eval/`.
- The script runs under Node's `--experimental-transform-types`, so everything it imports must use explicit `.ts` import extensions and no `enum`s. Files that import extensionlessly (`reconcile`, `toBill`) cannot be used from it.
- Committed receipt photos must be licensed for public use and listed in `fixtures/receipts/ATTRIBUTION.md`. Anything else goes in the git-ignored `fixtures/receipts-local/` (run with `--dir`).
- Cost figures come from `src/lib/receipt/eval/pricing.ts`. Update it when prices or the eval models change.
- `ANTHROPIC_API_KEY` is read from the environment only. Never print, log, or write it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
