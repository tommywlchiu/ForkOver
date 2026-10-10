-- pgTAP coverage for `bill_fees`' M4 policies (SPEC.md 8.2 "Membership", "Payer only"): payer and
-- member can read fees, only the payer can create/edit/delete them, and an outsider can't read
-- them at all.
begin;
select plan(7);

insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-000000000001', 'payer@fees.example'),
  ('e1000000-0000-0000-0000-000000000002', 'member@fees.example'),
  ('e1000000-0000-0000-0000-000000000003', 'outsider@fees.example');

insert into public.bills (id, payer_user_id, status)
values ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'open');

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

select lives_ok(
  $$ delete from public.bill_fees where id = 'e4000000-0000-0000-0000-000000000001' $$,
  'the payer can delete a fee'
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
