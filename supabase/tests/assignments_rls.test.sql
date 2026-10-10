-- pgTAP coverage for `assignments`' M4 policies and lock trigger (SPEC.md 8.2 "Membership",
-- "Payer only", "Triggers"; FR-12): only the payer can assign an item, members and the payer can
-- read assignments, an outsider can't, and assignment changes are rejected when the bill is
-- closed, the item has a payment, or `assigned_to` names someone off the bill.
begin;
select plan(12);

insert into auth.users (id, email) values
  ('a5000000-0000-0000-0000-000000000001', 'payer@assign.example'),
  ('a5000000-0000-0000-0000-000000000002', 'member@assign.example'),
  ('a5000000-0000-0000-0000-000000000003', 'outsider@assign.example');

insert into public.bills (id, payer_user_id, status)
values ('a6000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'open');

-- Created `open` and closed below, after its item exists: the item lock trigger now also fires
-- on INSERT (SPEC 8.5), and triggers run for every role including this fixture setup, so an item
-- can't be inserted directly onto an already-closed bill even here.
insert into public.bills (id, payer_user_id, status)
values ('a6000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000001', 'open');

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'a7000000-0000-0000-0000-000000000002',
  'a6000000-0000-0000-0000-000000000001',
  'a5000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_items (id, bill_id, name, price_cents, position) values
  ('a8000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'Burger', 1000, 0),
  ('a8000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000001', 'Shake', 500, 1),
  ('a8000000-0000-0000-0000-000000000003', 'a6000000-0000-0000-0000-000000000002', 'Soup', 500, 0);

update public.bills set status = 'closed' where id = 'a6000000-0000-0000-0000-000000000002';

set role authenticated;
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.assignments (item_id, bill_id, assigned_to)
     values (
       'a8000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001',
       array['a7000000-0000-0000-0000-000000000002']::uuid[]
     ) $$,
  'new row violates row-level security policy for table "assignments"',
  'a member cannot assign an item'
);

set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ insert into public.assignments (item_id, bill_id, assigned_to)
     values (
       'a8000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001',
       array['a7000000-0000-0000-0000-000000000002']::uuid[]
     ) $$,
  'the payer can assign an item'
);

select lives_ok(
  $$ update public.assignments set assigned_to = array[]::uuid[]
     where item_id = 'a8000000-0000-0000-0000-000000000001' $$,
  'the payer can edit an assignment'
);

select throws_ok(
  $$ update public.assignments
     set assigned_to = array['00000000-0000-0000-0000-000000000000']::uuid[]
     where item_id = 'a8000000-0000-0000-0000-000000000001' $$,
  'assignments.assigned_to contains a person not on this bill',
  'assigning to someone off the bill is rejected'
);

-- Assign the second item while it's still unpaid, then mark it paid, then prove the lock trigger
-- blocks reassigning it even for the payer.
select lives_ok(
  $$ insert into public.assignments (item_id, bill_id, assigned_to)
     values (
       'a8000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000001',
       array['a7000000-0000-0000-0000-000000000002']::uuid[]
     ) $$,
  'the payer can assign the second item before it has a payment'
);

reset role;
insert into public.payments (item_id, person_id, bill_id)
values (
  'a8000000-0000-0000-0000-000000000002',
  'a7000000-0000-0000-0000-000000000002',
  'a6000000-0000-0000-0000-000000000001'
);
set role authenticated;
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.assignments set assigned_to = array[]::uuid[]
     where item_id = 'a8000000-0000-0000-0000-000000000002' $$,
  'assignments locked: bill a6000000-0000-0000-0000-000000000001 is closed or item a8000000-0000-0000-0000-000000000002 has a paid portion',
  'reassigning an item with a paid portion is rejected'
);

select throws_ok(
  $$ insert into public.assignments (item_id, bill_id, assigned_to)
     values (
       'a8000000-0000-0000-0000-000000000003', 'a6000000-0000-0000-0000-000000000002',
       array[]::uuid[]
     ) $$,
  'assignments locked: bill a6000000-0000-0000-0000-000000000002 is closed or item a8000000-0000-0000-0000-000000000003 has a paid portion',
  'assigning on a closed bill is rejected'
);

set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select count(*)::int from public.assignments where bill_id = 'a6000000-0000-0000-0000-000000000001' $$,
  $$ values (2) $$,
  'a member can read the bill''s assignments'
);

set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000003';

select is_empty(
  $$ select 1 from public.assignments where bill_id = 'a6000000-0000-0000-0000-000000000001' $$,
  'an outsider cannot read any assignment'
);

select is_empty(
  $$ update public.assignments set assigned_to = array[]::uuid[]
     where item_id = 'a8000000-0000-0000-0000-000000000001'
     returning 1 $$,
  'an outsider cannot edit an assignment'
);

-- assignments_delete_payer: only the payer can delete an assignment.
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000002';

select is_empty(
  $$ delete from public.assignments
     where item_id = 'a8000000-0000-0000-0000-000000000001'
     returning 1 $$,
  'a member cannot delete an assignment'
);

set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ delete from public.assignments where item_id = 'a8000000-0000-0000-0000-000000000001' $$,
  'the payer can delete an assignment'
);

reset role;
select * from finish();
rollback;
