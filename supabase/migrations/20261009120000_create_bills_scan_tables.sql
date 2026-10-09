-- SPEC.md 8.1 / 8.4: the tables and storage bucket parse-receipt (M3, SPEC 7.1) needs to run.
--
-- Only the columns the Edge Function's data ports (`createDraftBill`, `storeReceiptImage`,
-- `discardDraftBill`, `checkLimits`, `recordSuccessfulScan`) actually read or write. No
-- `open`/`closed` bill lifecycle, no `bill_people`/`bill_items`/etc: those land with M4/M5's
-- migrations. Only the Edge Function (service role, which bypasses RLS) ever touches these three
-- tables or the bucket in M3 - RLS is enabled with zero policies on each, so `anon` and
-- `authenticated` are denied every operation by default (SPEC 8.2's "default-deny" baseline for
-- tables with no policies yet).

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  payer_user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  receipt_path text,
  created_at timestamptz not null default now()
);

alter table public.bills enable row level security;

-- SPEC 13 default 5: 3 successful scans per calendar month in UTC, keyed by 'YYYY-MM'.
create table public.scan_usage (
  user_id uuid not null references public.profiles (id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  count integer not null default 0,
  primary key (user_id, period)
);

alter table public.scan_usage enable row level security;

-- SPEC default 6: 10 scans per rolling hour per user. One row per scan attempt; checkLimits counts
-- rows from the last hour.
create table public.scan_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.scan_log enable row level security;

-- SPEC 8.4: private bucket, `<bill_id>/receipt.jpg`. No storage.objects policies are added, so
-- `anon`/`authenticated` can't list or read objects here either; members get access later (M4)
-- through short-lived signed URLs the service role issues, not direct bucket policies.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;
