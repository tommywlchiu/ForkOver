-- pgTAP coverage for the M3 tables (SPEC.md 8.1/8.4, AGENTS.md "every table has RLS enabled, and
-- every policy has a pgTAP test"): `scan_usage`, `scan_log`, and the `receipts` bucket still have
-- no policies at all, so a signed-in user is denied every read and write on them. Only
-- `parse-receipt`'s service-role client touches them. `bills` gained real policies in M4 (SPEC
-- 8.2), covered in bills_rls.test.sql; the one assertion about it below now checks that new,
-- intended behavior instead of the old "no policies yet" default-deny baseline.
begin;
select plan(11);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'payer@example.com');

-- Seed one row per table as the service role (bypasses RLS), so the test below can prove a
-- signed-in user can't even read a row that genuinely exists.
insert into public.bills (id, payer_user_id, status, receipt_path)
values ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'draft', '44444444-4444-4444-4444-444444444444/receipt.jpg');

insert into public.scan_usage (user_id, period, count)
values ('33333333-3333-3333-3333-333333333333', '2026-10', 1);

insert into public.scan_log (user_id)
values ('33333333-3333-3333-3333-333333333333');

insert into storage.objects (bucket_id, name, owner)
values ('receipts', '44444444-4444-4444-4444-444444444444/receipt.jpg', '33333333-3333-3333-3333-333333333333');

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

-- M4 (SPEC 8.2 "Membership") gave bills a real select policy: the payer can now read their own
-- bill. (Full payer/member/guest/outsider coverage of that policy lives in bills_rls.test.sql;
-- this just confirms the M3-era "default deny" assumption above no longer holds for this table.)
select results_eq(
  $$ select id from public.bills where id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid) $$,
  'signed-in payer can now read their own bills row (M4 added a select policy)'
);

select throws_ok(
  $$ insert into public.bills (payer_user_id, status) values ('33333333-3333-3333-3333-333333333333', 'draft') $$,
  'new row violates row-level security policy for table "bills"',
  'signed-in user cannot insert into bills'
);

select is_empty(
  $$ select 1 from public.scan_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'signed-in user cannot read their own scan_usage row'
);

-- Blocked by RLS before the WHERE clause can even match, so this is a no-op, not an error.
select is_empty(
  $$ update public.scan_usage set count = 99
     where user_id = '33333333-3333-3333-3333-333333333333' and period = '2026-10'
     returning count $$,
  'signed-in user cannot update scan_usage'
);

select is_empty(
  $$ select 1 from public.scan_log where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'signed-in user cannot read their own scan_log row'
);

-- The atomic increment helper (recordSuccessfulScan, SPEC 8.1) runs with the caller's own
-- rights (`security invoker`), so a signed-in user calling it directly still hits
-- scan_usage's policy-free RLS on the write inside, the same as writing the table themselves.
select throws_ok(
  $$ select public.increment_scan_usage('33333333-3333-3333-3333-333333333333', '2026-10') $$,
  'new row violates row-level security policy for table "scan_usage"',
  'signed-in user cannot call increment_scan_usage to bump their own quota'
);

select throws_ok(
  $$ insert into public.scan_log (user_id) values ('33333333-3333-3333-3333-333333333333') $$,
  'new row violates row-level security policy for table "scan_log"',
  'signed-in user cannot insert into scan_log'
);

-- Storage: can't list (select) or read the object a service-role scan already wrote.
select is_empty(
  $$ select 1 from storage.objects where bucket_id = 'receipts' $$,
  'signed-in user cannot list objects in the receipts bucket'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('receipts', '44444444-4444-4444-4444-444444444444/other.jpg', '33333333-3333-3333-3333-333333333333') $$,
  'new row violates row-level security policy for table "objects"',
  'signed-in user cannot upload into the receipts bucket'
);

-- An anonymous (unauthenticated) caller fares no better. An anon caller has no JWT at all, so
-- the leftover `request.jwt.claim.sub` from the payer above must be cleared too, or auth.uid()
-- would still resolve to the payer and the bills check below would pass for the wrong reason.
reset request.jwt.claim.sub;
reset role;
set role anon;

select is_empty(
  $$ select 1 from public.bills $$,
  'anon cannot read bills at all'
);

select is_empty(
  $$ select 1 from storage.objects where bucket_id = 'receipts' $$,
  'anon cannot list objects in the receipts bucket'
);

reset role;
select * from finish();
rollback;
