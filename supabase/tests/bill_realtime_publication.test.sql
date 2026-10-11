-- pgTAP coverage for the `supabase_realtime` publication (SPEC.md 8.3): every table a bill's
-- live screens subscribe to (src/data/supabaseBillStore.ts `ALL_BILL_TABLES`) must actually be in
-- the publication Supabase Realtime reads from, or `subscribeToBillChanges`'s subscription is a
-- no-op that never fires - the bug this migration exists to fix.
begin;
select plan(7);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bills'
  ),
  'bills is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bill_people'
  ),
  'bill_people is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bill_items'
  ),
  'bill_items is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bill_fees'
  ),
  'bill_fees is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'claims'
  ),
  'claims is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignments'
  ),
  'assignments is in the supabase_realtime publication'
);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payments'
  ),
  'payments is in the supabase_realtime publication'
);

select * from finish();
rollback;
