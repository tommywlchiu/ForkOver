-- pgTAP coverage for `bills`' M4 policies (SPEC.md 8.2 "Membership" and "Payer only"):
-- payer and member can read a bill, an outsider can't, and only the payer can update it.
begin;
select plan(7);

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'payer@bills.example'),
  ('b1000000-0000-0000-0000-000000000002', 'member@bills.example'),
  ('b1000000-0000-0000-0000-000000000003', 'outsider@bills.example');

insert into public.bills (id, payer_user_id, status)
values ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'open');

-- `on_bill_created` (AFTER INSERT on bills): gives the payer a `bill_people` row immediately,
-- so `claims.created_by` always has something to point at for the payer.
select results_eq(
  $$ select count(*)::int from public.bill_people
     where bill_id = 'b2000000-0000-0000-0000-000000000001'
       and user_id = 'b1000000-0000-0000-0000-000000000001'
       and kind = 'payer' $$,
  $$ values (1) $$,
  'on_bill_created gives the payer their own bill_people row'
);

-- Add the member's `bill_people` row directly as the service role (join_bill's own behavior is
-- covered in bill_people_rls.test.sql).
insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'b3000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

set role authenticated;
set request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000001';

select results_eq(
  $$ select status from public.bills where id = 'b2000000-0000-0000-0000-000000000001' $$,
  $$ values ('open'::text) $$,
  'payer can read their own bill'
);

-- `now()` is frozen for the lifetime of this transaction (so it can't distinguish a trigger-set
-- `updated_at` from the insert default here); `bills_set_updated_at` firing without error is
-- exercised by this and the other `lives_ok` UPDATE assertions in this suite.
select lives_ok(
  $$ update public.bills set title = 'Dinner' where id = 'b2000000-0000-0000-0000-000000000001' $$,
  'payer can update their own bill'
);

set request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select status from public.bills where id = 'b2000000-0000-0000-0000-000000000001' $$,
  $$ values ('open'::text) $$,
  'member can read a bill they belong to'
);

select is_empty(
  $$ update public.bills set title = 'Hacked'
     where id = 'b2000000-0000-0000-0000-000000000001'
     returning title $$,
  'member cannot update the bill'
);

set request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000003';

select is_empty(
  $$ select 1 from public.bills where id = 'b2000000-0000-0000-0000-000000000001' $$,
  'outsider cannot read the bill'
);

select is_empty(
  $$ update public.bills set title = 'Hacked'
     where id = 'b2000000-0000-0000-0000-000000000001'
     returning title $$,
  'outsider cannot update the bill'
);

reset role;
select * from finish();
rollback;
