-- pgTAP coverage for `claims`' M4 policies and lock trigger (SPEC.md 8.2 "Membership", "Claims",
-- "Triggers"; FR-32, FR-17): a person claims for themselves, the payer claims for anyone, nobody
-- claims for someone else, an outsider can't read claims, and claim changes are rejected once the
-- bill is closed, the item has a payment, or `bill_id` doesn't match the item/person it names.
begin;
select plan(10);

insert into auth.users (id, email) values
  ('f1000000-0000-0000-0000-000000000001', 'payer@claims.example'),
  ('f1000000-0000-0000-0000-000000000002', 'member-b@claims.example'),
  ('f1000000-0000-0000-0000-000000000003', 'member-c@claims.example'),
  ('f1000000-0000-0000-0000-000000000004', 'outsider@claims.example');

insert into public.bills (id, payer_user_id, status)
values ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'open');

-- A second, already-closed bill, for the closed-bill trigger and the bill_id spoofing check.
insert into public.bills (id, payer_user_id, status)
values ('f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'closed');

-- `handle_new_bill` already gave the payer their own bill_people row when the bill was inserted
-- above; only the two members need adding directly here.
insert into public.bill_people (id, bill_id, user_id, display_name, kind) values
  ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'Member B', 'member'),
  ('f3000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003', 'Member C', 'member');

insert into public.bill_items (id, bill_id, name, price_cents, position) values
  ('f4000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Pizza', 1200, 0),
  ('f4000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'Salad', 800, 1);

-- A paid item, for the lock trigger.
insert into public.payments (item_id, person_id, bill_id)
values ('f4000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001');

-- An item on the already-closed bill, for the closed-bill trigger.
insert into public.bill_items (id, bill_id, name, price_cents, position)
values ('f4000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000002', 'Soup', 500, 0);

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values ('f3000000-0000-0000-0000-000000000009', 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002', 'Member B', 'member');

set role authenticated;
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000002',
       'f2000000-0000-0000-0000-000000000001', 'mine', 'f3000000-0000-0000-0000-000000000002'
     ) $$,
  'a member can claim an item for themselves'
);

select throws_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000003',
       'f2000000-0000-0000-0000-000000000001', 'mine', 'f3000000-0000-0000-0000-000000000002'
     ) $$,
  'new row violates row-level security policy for table "claims"',
  'a member cannot claim an item for someone else'
);

select lives_ok(
  $$ update public.claims set mode = 'shared'
     where item_id = 'f4000000-0000-0000-0000-000000000001'
       and person_id = 'f3000000-0000-0000-0000-000000000002' $$,
  'a member can update their own claim'
);

-- A non-payer member can claim for themselves (person_id passes the RLS policy), but can't
-- misattribute it by setting created_by to someone else's bill_people row.
select throws_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000002',
       'f2000000-0000-0000-0000-000000000001', 'mine', 'f3000000-0000-0000-0000-000000000003'
     ) $$,
  'claims.created_by must be the caller''s own bill_people row, or the payer''s',
  'a member cannot claim for themselves while misattributing created_by to someone else'
);

set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000003',
       'f2000000-0000-0000-0000-000000000001', 'shared',
       (select id from public.bill_people
        where bill_id = 'f2000000-0000-0000-0000-000000000001' and kind = 'payer')
     ) $$,
  'the payer can claim an item on behalf of anyone (FR-32)'
);

-- Member C tries to delete member B's claim. RLS filters the row out of view before the DELETE
-- can even match it, so this is a silent no-op rather than an error (same pattern as the M3
-- default-deny tests).
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000003';

select is_empty(
  $$ delete from public.claims
     where item_id = 'f4000000-0000-0000-0000-000000000001'
       and person_id = 'f3000000-0000-0000-0000-000000000002'
     returning 1 $$,
  'member C cannot delete member B''s claim'
);

set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000004';

select is_empty(
  $$ select 1 from public.claims where bill_id = 'f2000000-0000-0000-0000-000000000001' $$,
  'an outsider cannot read any claim'
);

-- The lock trigger: an item with a paid portion rejects new claims, even from the payer.
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000003',
       'f2000000-0000-0000-0000-000000000001', 'mine',
       (select id from public.bill_people
        where bill_id = 'f2000000-0000-0000-0000-000000000001' and kind = 'payer')
     ) $$,
  'claims locked: bill f2000000-0000-0000-0000-000000000001 is closed or item f4000000-0000-0000-0000-000000000002 has a paid portion',
  'claiming an item with a paid portion is rejected'
);

-- The closed-bill trigger rejects new claims, even on an item with no payment.
select throws_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000003', 'f3000000-0000-0000-0000-000000000009',
       'f2000000-0000-0000-0000-000000000002', 'mine', 'f3000000-0000-0000-0000-000000000009'
     ) $$,
  'claims locked: bill f2000000-0000-0000-0000-000000000002 is closed or item f4000000-0000-0000-0000-000000000003 has a paid portion',
  'claiming on a closed bill is rejected'
);

-- A spoofed bill_id (pointing claims.bill_id at the closed bill while item_id/person_id are on
-- the open one) is rejected before the closed/paid checks even run.
select throws_ok(
  $$ insert into public.claims (item_id, person_id, bill_id, mode, created_by)
     values (
       'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000003',
       'f2000000-0000-0000-0000-000000000002', 'mine',
       (select id from public.bill_people
        where bill_id = 'f2000000-0000-0000-0000-000000000001' and kind = 'payer')
     ) $$,
  'claims.bill_id does not match the item''s bill',
  'a spoofed bill_id is rejected'
);

reset role;
select * from finish();
rollback;
