-- pgTAP coverage for `payments`' M4 policies and consistency trigger (SPEC.md 8.2 "Membership",
-- "Payer only", "Triggers"; FR-25): only the payer marks or unmarks payments, members and the
-- payer can read them, an outsider can't, payments are allowed even on a closed bill, and a
-- spoofed `bill_id` is rejected.
begin;
select plan(8);

insert into auth.users (id, email) values
  ('b5000000-0000-0000-0000-000000000001', 'payer@pay.example'),
  ('b5000000-0000-0000-0000-000000000002', 'member@pay.example'),
  ('b5000000-0000-0000-0000-000000000003', 'outsider@pay.example');

insert into public.bills (id, payer_user_id, status)
values ('b6000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001', 'open');

-- Created `open` and closed below, after its item exists: the bill_items lock trigger now also
-- fires on INSERT (SPEC 8.5) for every role including this fixture setup, so the item can't be
-- inserted directly once the bill is already closed. Payments themselves are exempt (FR-25), so
-- only the item insert needs this two-step dance.
insert into public.bills (id, payer_user_id, status)
values ('b6000000-0000-0000-0000-000000000002', 'b5000000-0000-0000-0000-000000000001', 'open');

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'b7000000-0000-0000-0000-000000000002',
  'b6000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'b7000000-0000-0000-0000-000000000009',
  'b6000000-0000-0000-0000-000000000002',
  'b5000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_items (id, bill_id, name, price_cents, position)
values ('b8000000-0000-0000-0000-000000000001', 'b6000000-0000-0000-0000-000000000001', 'Tacos', 900, 0);

insert into public.bill_items (id, bill_id, name, price_cents, position)
values ('b8000000-0000-0000-0000-000000000002', 'b6000000-0000-0000-0000-000000000002', 'Soup', 500, 0);

update public.bills set status = 'closed' where id = 'b6000000-0000-0000-0000-000000000002';

set role authenticated;
set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000002',
       'b6000000-0000-0000-0000-000000000001'
     ) $$,
  'new row violates row-level security policy for table "payments"',
  'a member cannot mark a payment'
);

set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000002',
       'b6000000-0000-0000-0000-000000000001'
     ) $$,
  'the payer can mark a payment'
);

select lives_ok(
  $$ delete from public.payments
     where item_id = 'b8000000-0000-0000-0000-000000000001'
       and person_id = 'b7000000-0000-0000-0000-000000000002' $$,
  'the payer can unmark a payment'
);

-- FR-25: payment changes are still allowed on a closed bill (unlike claims/assignments).
select lives_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000002', 'b7000000-0000-0000-0000-000000000009',
       'b6000000-0000-0000-0000-000000000002'
     ) $$,
  'the payer can mark a payment on a closed bill'
);

select throws_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000002',
       'b6000000-0000-0000-0000-000000000002'
     ) $$,
  'payments.bill_id does not match the item''s bill',
  'a spoofed bill_id is rejected'
);

set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select count(*)::int from public.payments where bill_id = 'b6000000-0000-0000-0000-000000000002' $$,
  $$ values (1) $$,
  'a member can read the bill''s payments'
);

set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000003';

select is_empty(
  $$ select 1 from public.payments where bill_id = 'b6000000-0000-0000-0000-000000000002' $$,
  'an outsider cannot read any payment'
);

select throws_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000002',
       'b6000000-0000-0000-0000-000000000001'
     ) $$,
  'new row violates row-level security policy for table "payments"',
  'an outsider cannot mark a payment'
);

reset role;
select * from finish();
rollback;
