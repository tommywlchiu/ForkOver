-- SPEC.md 8.7 (FR-35/36): an outbox table for the `notify` function. Each row is one push-worthy
-- event; a database webhook (next migration) fires on insert and POSTs the row to the `notify`
-- Edge Function. This is deliberately a generic queue, not a trigger wired straight to
-- `bill_people`: `bill_people` gets a `kind = 'member'` row both from a payer's explicit
-- `invite_bill_member` call (SPEC 8.7's "payer sends a bill to a member" trigger) *and* from a
-- user joining themselves via `join_bill` on a share link (not a notification trigger at all,
-- and there is no column today that tells those two apart) - a trigger directly on `bill_people`
-- would have to grow ad hoc "but only when" conditions to separate them. Routing every trigger
-- through its own call into this table instead means each one explicitly says what happened and
-- for whom, and - the point of "one function per event type, not a monolith" from the M4 task
-- brief - the M5 conflict and last-unclaimed-item triggers (SPEC 8.7's other two) just become more
-- `event_type` values and more call sites, with no change to the webhook or this table.
--
-- `payload` carries nothing from a bill's contents (SPEC 8.8's privacy stance): today's only
-- event type needs no extra data beyond `bill_id`/`recipient_user_id`, so it's always `{}`, but
-- the column exists for a future event type that does.
create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('bill_member_invited')),
  bill_id uuid not null references public.bills (id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index notification_events_recipient_idx on public.notification_events (recipient_user_id);

-- Same shape as `bills`/`scan_usage`/`scan_log` (AGENTS.md): RLS enabled, zero policies, so
-- `anon`/`authenticated` are denied by default and only a security-definer function (the next
-- migration's `invite_bill_member` update) or the service-role `notify` function can touch it.
alter table public.notification_events enable row level security;
