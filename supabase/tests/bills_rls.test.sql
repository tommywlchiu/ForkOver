-- pgTAP coverage for `bills`' M4 policies (SPEC.md 8.2 "Membership" and "Payer only"):
-- payer and member can read a bill, an outsider can't, and only the payer can update it.
begin;
select plan(11);

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'payer@bills.example'),
  ('b1000000-0000-0000-0000-000000000002', 'member@bills.example'),
  ('b1000000-0000-0000-0000-000000000003', 'outsider@bills.example');

insert into public.bills (id, payer_user_id, status)
values ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'open');

-- A second, already-closed bill, for the closed-state lock test below. `bills` has no insert
-- policy at all (creating one is service-role only, as in M3), so this has to happen here, before
-- the role switch to `authenticated`.
insert into public.bills (id, payer_user_id, status, tax_cents)
values ('b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'closed', 500);

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

-- The payer can change bill status/receipt-level fields, but not identity/addressing fields:
-- payer_user_id (would hand the bill to someone else) or share_token (would regenerate the
-- public link). RLS alone can't restrict which columns an UPDATE touches, so this is enforced by
-- bills_immutable_fields_guard.
select throws_ok(
  $$ update public.bills set payer_user_id = 'b1000000-0000-0000-0000-000000000002'
     where id = 'b2000000-0000-0000-0000-000000000001' $$,
  'bills.payer_user_id cannot be changed',
  'the payer cannot transfer the bill to someone else'
);

select throws_ok(
  $$ update public.bills set share_token = 'stolen-link'
     where id = 'b2000000-0000-0000-0000-000000000001' $$,
  'bills.share_token cannot be changed',
  'the payer cannot regenerate the share_token'
);

-- SPEC 8.5: "Closed bills are read-only except payment marks." Once closed, the split-affecting
-- fields (tax_cents, discount_cents, tip, currency) lock too - changing them would silently
-- alter everyone's already-settled share - but cosmetic fields like title stay editable.
select throws_ok(
  $$ update public.bills set tax_cents = 999
     where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'bills locked: bill b2000000-0000-0000-0000-000000000002 is closed',
  'the payer cannot change tax_cents on a closed bill'
);

select lives_ok(
  $$ update public.bills set title = 'Dinner (final)'
     where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'the payer can still edit cosmetic fields on a closed bill'
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
