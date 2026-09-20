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
