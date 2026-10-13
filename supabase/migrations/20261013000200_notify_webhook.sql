-- SPEC.md 8.7: "The notify function runs from database webhooks" - a `supabase_functions.
-- http_request` trigger (every Supabase project's own schema, not something this migration
-- creates), the same mechanism Studio's "Database Webhooks" UI generates, so a client can never
-- skip the push by just not calling an RPC. Fires once per `notification_events` insert and POSTs
-- the row (`{type, table, schema, record, old_record}`, Supabase's fixed webhook payload shape)
-- to the `notify` function, which holds the service-role key this needs and the client has no
-- business holding.
--
-- The URL below is the local stack's own address for calling an Edge Function from inside the
-- database container (`host.docker.internal`, not `localhost`, which from inside Postgres
-- resolves to the Postgres container itself - see Supabase's local development docs). It only
-- works against `supabase start`, which is exactly what this task verifies against. Deploying to
-- a real project needs this trigger recreated against that project's own function URL
-- (`https://<project-ref>.supabase.co/functions/v1/notify`) - do that the same way Studio's own
-- webhook UI would (or a follow-up migration with the real URL once one exists); don't assume this
-- migration alone makes production notifications work.
--
-- `supabase_functions.http_request` calls out through `pg_net` (schema `net`), which is not one
-- of this project's extensions yet (`uuid-ossp`/`pgcrypto`, previous migrations) - a fresh local
-- stack or project doesn't have it until something enables it. Hosted Supabase projects already
-- have `pg_net` pre-installed in `extensions`; `if not exists` makes this a no-op there.
create extension if not exists pg_net schema extensions;

-- `notify` has `verify_jwt = false` (config.toml) - there is no signed-in user's JWT to check on
-- a call that only ever comes from this trigger. Without some other check, its URL is exactly as
-- guessable as `parse-receipt`'s (same project ref, already public in the shipped app's
-- `SUPABASE_URL`), so anyone could POST a fake `{record: {...}}` body directly and get an
-- arbitrary user an arbitrary push. The `x-notify-secret` header is that check: `notify` rejects
-- any request where it doesn't match its own `NOTIFY_WEBHOOK_SECRET` function secret, before
-- doing anything else (index.ts).
--
-- The value below is a local-development secret only, generated for this repo's own Docker stack
-- - never a production credential, and there is no reason it needs to be, since it protects
-- nothing of value locally. A real deployment must not reuse this literal value: generate a new
-- one, `supabase secrets set NOTIFY_WEBHOOK_SECRET=<it>` against that project, and create this
-- trigger there (Studio's webhook UI, or a follow-up migration) with that value in the header
-- instead - the same "don't assume this migration alone makes production work" caveat as the URL
-- above.
create trigger "notify_on_notification_event"
after insert on public.notification_events
for each row
execute function supabase_functions.http_request(
  'http://host.docker.internal:54321/functions/v1/notify',
  'POST',
  '{"Content-type":"application/json","x-notify-secret":"20c769f25bcb43259db2eb1c6727aade386e0f7f541f8a03"}',
  '{}',
  '5000'
);
