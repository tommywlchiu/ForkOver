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

create trigger "notify_on_notification_event"
after insert on public.notification_events
for each row
execute function supabase_functions.http_request(
  'http://host.docker.internal:54321/functions/v1/notify',
  'POST',
  '{"Content-type":"application/json"}',
  '{}',
  '5000'
);
