-- pgTAP coverage for `payments`' M4 policies and consistency trigger (SPEC.md 8.2 "Membership",
-- "Payer only", "Triggers"; FR-25): only the payer marks or unmarks payments, members and the
-- payer can read them, an outsider can't, payments are allowed even on a closed bill, and a
-- spoofed `bill_id` is rejected.
begin;
select plan(12);

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

-- Re-mark it so the next two checks (non-payer delete denied, no UPDATE policy at all) have a
-- row to target.
select lives_ok(
  $$ insert into public.payments (item_id, person_id, bill_id)
     values (
       'b8000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000002',
       'b6000000-0000-0000-0000-000000000001'
     ) $$,
  'the payer can re-mark the payment'
);

set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000002';

select is_empty(
  $$ delete from public.payments
     where item_id = 'b8000000-0000-0000-0000-000000000001'
       and person_id = 'b7000000-0000-0000-0000-000000000002'
     returning 1 $$,
  'a non-payer member cannot unmark a payment'
);

set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000001';

-- There's no UPDATE policy on payments at all (the app only ever inserts/deletes to mark/
-- unmark; marked_at is never edited in place) - not even the payer can update one.
select is_empty(
  $$ update public.payments set marked_at = now()
     where item_id = 'b8000000-0000-0000-0000-000000000001'
       and person_id = 'b7000000-0000-0000-0000-000000000002'
     returning 1 $$,
  'not even the payer can update a payment (no update policy exists)'
);

-- The trigger-level immutability guard is defense in depth below RLS (which already blocks this
-- for every real caller via the missing UPDATE policy above); check it fires for every role,
-- same as every other guard trigger in this migration, by running it as the service role.
reset role;

select throws_ok(
  $$ update public.payments set item_id = 'b8000000-0000-0000-0000-000000000002'
     where item_id = 'b8000000-0000-0000-0000-000000000001'
       and person_id = 'b7000000-0000-0000-0000-000000000002' $$,
  'payments.item_id and payments.person_id cannot be changed after creation',
  'reassigning a payment to a different item is rejected, even for the service role'
);

set role authenticated;
set request.jwt.claim.sub = 'b5000000-0000-0000-0000-000000000001';

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
