-- pgTAP coverage for `bill_fees`' M4 policies and lock trigger (SPEC.md 8.2 "Membership", "Payer
-- only", "Triggers"; SPEC 8.5): payer and member can read fees, only the payer can
-- create/edit/delete them, an outsider can't read them at all, and fees are locked once the bill
-- is closed since they feed the split math directly.
begin;
select plan(10);

insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-000000000001', 'payer@fees.example'),
  ('e1000000-0000-0000-0000-000000000002', 'member@fees.example'),
  ('e1000000-0000-0000-0000-000000000003', 'outsider@fees.example');

insert into public.bills (id, payer_user_id, status)
values ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'open');

-- A second bill the same payer owns, for the bill_id-immutability test, and a third, already
-- closed, for the closed-bill lock.
insert into public.bills (id, payer_user_id, status)
values ('e2000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'open');

-- Created `open` and closed below, after its fee exists: the new closed-bill lock trigger fires
-- for every role including this fixture setup, so a fee can't be inserted directly onto an
-- already-closed bill even here.
insert into public.bills (id, payer_user_id, status)
values ('e2000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000001', 'open');

insert into public.bill_fees (id, bill_id, label, cents, split)
values (
  'e4000000-0000-0000-0000-000000000003',
  'e2000000-0000-0000-0000-000000000003',
  'Service',
  400,
  'proportional'
);

update public.bills set status = 'closed' where id = 'e2000000-0000-0000-0000-000000000003';

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'e3000000-0000-0000-0000-000000000002',
  'e2000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_fees (id, bill_id, label, cents, split)
values (
  'e4000000-0000-0000-0000-000000000001',
  'e2000000-0000-0000-0000-000000000001',
  'Delivery',
  500,
  'equal'
);

set role authenticated;
set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';

select results_eq(
  $$ select label from public.bill_fees where id = 'e4000000-0000-0000-0000-000000000001' $$,
  $$ values ('Delivery'::text) $$,
  'the payer can read the fee'
);

select lives_ok(
  $$ insert into public.bill_fees (bill_id, label, cents, split)
     values ('e2000000-0000-0000-0000-000000000001', 'Service', 800, 'proportional') $$,
  'the payer can add a fee'
);

select lives_ok(
  $$ update public.bill_fees set cents = 550 where id = 'e4000000-0000-0000-0000-000000000001' $$,
  'the payer can edit a fee'
);

-- bill_id is immutable after creation, even for the payer moving a fee between two bills they own.
select throws_ok(
  $$ update public.bill_fees set bill_id = 'e2000000-0000-0000-0000-000000000002'
     where id = 'e4000000-0000-0000-0000-000000000001' $$,
  'bill_fees.bill_id cannot be changed after creation',
  'moving a fee to another bill is rejected'
);

select lives_ok(
  $$ delete from public.bill_fees where id = 'e4000000-0000-0000-0000-000000000001' $$,
  'the payer can delete a fee'
);

-- SPEC 8.5: fees feed the split math directly, so a closed bill locks them too, same as items.
select throws_ok(
  $$ update public.bill_fees set cents = 450
     where id = 'e4000000-0000-0000-0000-000000000003' $$,
  'bill_fees locked: bill e2000000-0000-0000-0000-000000000003 is closed',
  'editing a fee on a closed bill is rejected'
);

select throws_ok(
  $$ insert into public.bill_fees (bill_id, label, cents, split)
     values ('e2000000-0000-0000-0000-000000000003', 'Bag fee', 50, 'equal') $$,
  'bill_fees locked: bill e2000000-0000-0000-0000-000000000003 is closed',
  'adding a fee to a closed bill is rejected'
);

set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.bill_fees (bill_id, label, cents, split)
     values ('e2000000-0000-0000-0000-000000000001', 'Sneaky', 100, 'equal') $$,
  'new row violates row-level security policy for table "bill_fees"',
  'a member cannot add a fee'
);

select is_empty(
  $$ update public.bill_fees set cents = 1
     where bill_id = 'e2000000-0000-0000-0000-000000000001'
     returning cents $$,
  'a member cannot edit a fee'
);

set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000003';

select is_empty(
  $$ select 1 from public.bill_fees where bill_id = 'e2000000-0000-0000-0000-000000000001' $$,
  'an outsider cannot read any fee'
);

reset role;
select * from finish();
rollback;
