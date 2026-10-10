-- pgTAP coverage for `bills`' M4 policies and triggers (SPEC.md 8.2 "Membership" and "Payer
-- only"; SPEC 8.5): payer and member can read a bill, an outsider can't, only the payer can
-- update it, nothing (including `status` itself) can change once it's closed, there's no delete
-- policy at all, and `closed_at` is derived rather than trusted from the caller.
begin;
select plan(21);

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'payer@bills.example'),
  ('b1000000-0000-0000-0000-000000000002', 'member@bills.example'),
  ('b1000000-0000-0000-0000-000000000003', 'outsider@bills.example'),
  ('b1000000-0000-0000-0000-000000000006', 'guest@bills.example');

-- A payer who never filled in profiles.display_name (true of every user today - no client code
-- writes that column) but does have an OAuth full_name, for the handle_new_bill fallback test.
insert into auth.users (id, email, raw_user_meta_data)
values (
  'b1000000-0000-0000-0000-000000000005',
  'named-payer@bills.example',
  '{"full_name": "Jamie Payer"}'::jsonb
);

insert into public.bills (id, payer_user_id, status)
values ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'open');

-- A second, already-closed bill, for the closed-state lock tests below, and a third, open, for
-- the immutable-identity-fields and tip-shape tests. `bills` has no insert policy at all
-- (creating one is service-role only, as in M3), so these all have to happen here, before the
-- role switch to `authenticated`.
insert into public.bills (id, payer_user_id, status, tax_cents)
values ('b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'closed', 500);

insert into public.bills (id, payer_user_id, status)
values ('b2000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', 'open');

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

-- handle_new_bill falls back through profiles.display_name (always null today), then OAuth
-- user_metadata, before the literal 'Payer' - matching applySession's own fallback chain in
-- src/state/session.ts, rather than falling straight through to 'Payer' for every bill.
insert into public.bills (id, payer_user_id, status)
values ('b2000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000005', 'open');

select results_eq(
  $$ select display_name from public.bill_people
     where bill_id = 'b2000000-0000-0000-0000-000000000005' and kind = 'payer' $$,
  $$ values ('Jamie Payer'::text) $$,
  'on_bill_created falls back to the OAuth display name, not a literal "Payer"'
);

-- Add the member's and a guest's `bill_people` rows directly as the service role (join_bill's
-- own behavior, including how a guest's row gets created, is covered in bill_people_rls.test.sql
-- - RLS itself doesn't distinguish 'member' from 'guest', both just need a bill_people row).
insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'b3000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Member',
  'member'
);

insert into public.bill_people (id, bill_id, user_id, display_name, kind)
values (
  'b3000000-0000-0000-0000-000000000006',
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000006',
  'Guest',
  'guest'
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
  'payer can update their own open bill'
);

-- guard_bills_closed_lock derives closed_at from the open->closed transition itself, overriding
-- whatever the caller passed, so status and closed_at can't drift apart.
with closed as (
  update public.bills
  set status = 'closed', closed_at = '1999-01-01'::timestamptz
  where id = 'b2000000-0000-0000-0000-000000000001'
  returning closed_at
)
select ok(
  (select closed_at is distinct from '1999-01-01'::timestamptz from closed),
  'closing a bill derives closed_at rather than trusting the caller-supplied value'
);

-- The payer can change bill status/receipt-level fields on an open bill, but not
-- identity/addressing fields: payer_user_id (would hand the bill to someone else) or share_token
-- (would regenerate the public link). RLS alone can't restrict which columns an UPDATE touches,
-- so this is enforced by bills_immutable_fields_guard. Use the third fixture bill for this (the
-- first one just got closed above).
select throws_ok(
  $$ update public.bills set payer_user_id = 'b1000000-0000-0000-0000-000000000002'
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'bills.payer_user_id cannot be changed',
  'the payer cannot transfer the bill to someone else'
);

select throws_ok(
  $$ update public.bills set share_token = 'stolen-link'
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'bills.share_token cannot be changed',
  'the payer cannot regenerate the share_token'
);

-- AGENTS.md: money is integer minor units everywhere, no floats in math. `tip` mirrors
-- `src/lib/split/split.ts`'s `Tip` union exactly, enforced by the bills_tip_shape CHECK.
select lives_ok(
  $$ update public.bills set tip = '{"kind":"amount","cents":500}'::jsonb
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'a valid amount tip is accepted'
);

select lives_ok(
  $$ update public.bills
     set tip = '{"kind":"percent","bps":1800,"base":"preTax"}'::jsonb
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'a valid percent tip is accepted'
);

select throws_ok(
  $$ update public.bills set tip = '{"kind":"amount","cents":5.5}'::jsonb
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'new row for relation "bills" violates check constraint "bills_tip_shape"',
  'a non-integer tip amount is rejected'
);

select throws_ok(
  $$ update public.bills set tip = '{"kind":"percent","bps":1800}'::jsonb
     where id = 'b2000000-0000-0000-0000-000000000004' $$,
  'new row for relation "bills" violates check constraint "bills_tip_shape"',
  'a percent tip missing base is rejected'
);

-- SPEC 8.5: "Closed bills are read-only except payment marks." Once closed, nothing changes -
-- not even cosmetic fields, and not `status` itself (reopening it would silently unlock every
-- other dependent table, since they all key off `is_bill_closed`).
select throws_ok(
  $$ update public.bills set tax_cents = 999
     where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'bills locked: bill b2000000-0000-0000-0000-000000000002 is closed',
  'the payer cannot change tax_cents on a closed bill'
);

select throws_ok(
  $$ update public.bills set title = 'Dinner (final)'
     where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'bills locked: bill b2000000-0000-0000-0000-000000000002 is closed',
  'the payer cannot edit cosmetic fields on a closed bill either'
);

select throws_ok(
  $$ update public.bills set status = 'open'
     where id = 'b2000000-0000-0000-0000-000000000002' $$,
  'bills locked: bill b2000000-0000-0000-0000-000000000002 is closed',
  'the payer cannot reopen a closed bill to edit it and re-close it'
);

-- There's no delete policy on `bills` at all: the payer's DELETE is filtered out before it can
-- even match the row (same no-op-not-error pattern as every other no-policy case in this suite).
select is_empty(
  $$ delete from public.bills
     where id = 'b2000000-0000-0000-0000-000000000001'
     returning 1 $$,
  'the payer cannot delete a bill (no delete policy exists)'
);

set request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select status from public.bills where id = 'b2000000-0000-0000-0000-000000000001' $$,
  $$ values ('closed'::text) $$,
  'member can read a bill they belong to'
);

select is_empty(
  $$ update public.bills set title = 'Hacked'
     where id = 'b2000000-0000-0000-0000-000000000001'
     returning title $$,
  'member cannot update the bill'
);

set request.jwt.claim.sub = 'b1000000-0000-0000-0000-000000000006';

select results_eq(
  $$ select status from public.bills where id = 'b2000000-0000-0000-0000-000000000001' $$,
  $$ values ('closed'::text) $$,
  'a guest can read a bill they belong to'
);

select is_empty(
  $$ update public.bills set title = 'Hacked'
     where id = 'b2000000-0000-0000-0000-000000000001'
     returning title $$,
  'a guest cannot update the bill'
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
