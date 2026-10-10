-- pgTAP coverage for `bill_items`' M4 policies and lock trigger (SPEC.md 8.2 "Membership",
-- "Payer only", "Triggers"; FR-17): payer and member can read items, only the payer can
-- create/edit/delete them, an outsider can't, and an item with any paid portion is locked even
-- for the payer.
begin;
select plan(11);

insert into auth.users (id, email) values
  ('d1000000-0000-0000-0000-000000000001', 'payer@items.example'),
  ('d1000000-0000-0000-0000-000000000002', 'member@items.example'),
  ('d1000000-0000-0000-0000-000000000003', 'outsider@items.example');

insert into public.bills (id, payer_user_id, status)
values ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'open');

-- A second bill the same payer owns, for the bill_id-immutability test, and a third, already
-- closed, for the closed-bill lock.
insert into public.bills (id, payer_user_id, status)
values ('d2000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'open');

insert into public.bills (id, payer_user_id, status)
values ('d2000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'closed');

insert into public.bill_items (id, bill_id, name, price_cents, position)
values ('d4000000-0000-0000-0000-000000000003', 'd2000000-0000-0000-0000-000000000003', 'Soup', 500, 0);

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'd3000000-0000-0000-0000-000000000002',
  'd2000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_items (id, bill_id, name, price_cents, position)
values (
  'd4000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'Salmon',
  2800,
  0
);

set role authenticated;
set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000001';

select results_eq(
  $$ select name from public.bill_items where id = 'd4000000-0000-0000-0000-000000000001' $$,
  $$ values ('Salmon'::text) $$,
  'the payer can read the item'
);

select lives_ok(
  $$ insert into public.bill_items (id, bill_id, name, price_cents, position)
     values (
       'd4000000-0000-0000-0000-000000000002',
       'd2000000-0000-0000-0000-000000000001',
       'Fries',
       600,
       1
     ) $$,
  'the payer can add an item'
);

select lives_ok(
  $$ update public.bill_items set price_cents = 2900
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'the payer can edit an unpaid item'
);

select lives_ok(
  $$ delete from public.bill_items where id = 'd4000000-0000-0000-0000-000000000002' $$,
  'the payer can delete an unpaid item'
);

-- bill_id is immutable after creation, even for the payer moving an item between two bills they
-- own - nothing in SPEC 8.1 asks for this, and it would orphan dependent claims/assignments/
-- payments rows.
select throws_ok(
  $$ update public.bill_items set bill_id = 'd2000000-0000-0000-0000-000000000002'
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'bill_items.bill_id cannot be changed after creation',
  'moving an item to another bill is rejected'
);

-- FR-17/SPEC 8.5: a closed bill locks its items too, even with no payment.
select throws_ok(
  $$ update public.bill_items set name = 'Renamed'
     where id = 'd4000000-0000-0000-0000-000000000003' $$,
  'bill_items locked: item d4000000-0000-0000-0000-000000000003 is closed or has a paid portion',
  'editing an item on a closed bill is rejected'
);

set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select name from public.bill_items where id = 'd4000000-0000-0000-0000-000000000001' $$,
  $$ values ('Salmon'::text) $$,
  'a member can read the item'
);

select throws_ok(
  $$ insert into public.bill_items (bill_id, name, price_cents, position)
     values ('d2000000-0000-0000-0000-000000000001', 'Sneaky', 100, 2) $$,
  'new row violates row-level security policy for table "bill_items"',
  'a member cannot add an item'
);

set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000003';

select is_empty(
  $$ select 1 from public.bill_items where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'an outsider cannot read the item'
);

-- Mark a portion of the item paid (service role write), then prove even the payer can no longer
-- edit or delete it (FR-17).
reset role;
insert into public.payments (item_id, person_id, bill_id)
values (
  'd4000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000002',
  'd2000000-0000-0000-0000-000000000001'
);

set role authenticated;
set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.bill_items set name = 'Renamed'
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'bill_items locked: item d4000000-0000-0000-0000-000000000001 is closed or has a paid portion',
  'the payer cannot edit an item with a paid portion'
);

select throws_ok(
  $$ delete from public.bill_items where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'bill_items locked: item d4000000-0000-0000-0000-000000000001 is closed or has a paid portion',
  'the payer cannot delete an item with a paid portion'
);

reset role;
select * from finish();
rollback;
