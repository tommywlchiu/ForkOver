# `.well-known/` — universal links fixtures, not yet functional

`apple-app-site-association` and `assetlinks.json` here are **fixtures**, not real
association files. They exist to prove the serving mechanism (plain HTTPS, correct
content type, not swallowed by Expo Router's web routing) works, per SPEC.md line 132.
They will **silently fail to verify** on a real device because every identifier inside
them is a placeholder:

- `apple-app-site-association`: needs a real Apple Team ID and the app's real
  `ios.bundleIdentifier` (from `app.json`), which need an Apple Developer account.
- `assetlinks.json`: needs the app's real `android.package` (from `app.json`) and the
  SHA256 fingerprint(s) of the actual signing certificate(s) (debug and release are
  different). The fingerprints come from a real EAS project's signing credentials — none
  exists yet (see `AGENTS.md`'s note on `src/data/pushTokens.ts`).

There is also no production web origin/domain configured anywhere in this repo yet, so
`ios.associatedDomains` (`applinks:<domain>`) and `android.intentFilters` in `app.json`
have nothing real to point at either.

**Content-Type caveat, confirmed against this repo's own build**: `npx expo export -p web`
passes both files through to `dist/.well-known/` untouched and `npx expo serve` serves
them over plain HTTPS at `/.well-known/*` with no redirect and no SPA catch-all
swallowing the route (Expo Router's static web output treats `public/` as a verbatim
passthrough, same as `favicon.png`). However, `apple-app-site-association` has no file
extension, so static file servers that infer `Content-Type` from the extension (Expo's
`expo serve`, and most others) serve it as `application/octet-stream`, not
`application/json` as Apple requires. `assetlinks.json` is served correctly as
`application/json` since it has a real extension. Whatever hosting provider ends up
serving the production web origin (none is chosen yet - no `vercel.json`/`netlify.toml`
in this repo) will need an explicit header rule forcing `Content-Type: application/json`
for `/.well-known/apple-app-site-association` specifically.

Once all three exist (web domain, Apple Team ID + bundle identifier, EAS project +
Android package + signing fingerprints):

1. Replace the placeholder values in both files and delete each file's `_fixture` key.
2. Add `ios.associatedDomains: ["applinks:<domain>"]` and the matching
   `android.intentFilters` autoVerify block to `app.json`.
3. Re-verify both files are still served with no redirect and the right content type
   (`application/json` for both, including the extensionless
   `apple-app-site-association`) from the production web origin, and that Apple's/
   Google's own validators accept them.
