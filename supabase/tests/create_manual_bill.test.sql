-- pgTAP coverage for `create_manual_bill` (SPEC.md 8.1/8.2, M4 realtime-store task): a signed-in,
-- non-anonymous user can create their own draft bill through the RPC even though `bills` has no
-- INSERT policy at all for a normal client; an anonymous session and a session with no auth
-- context cannot; and a direct INSERT against `bills` (bypassing the RPC) still fails, proving
-- the RPC is the only route in, not a hole in the table's own policies.
begin;
select plan(9);

insert into auth.users (id, email) values
  ('d1000000-0000-0000-0000-000000000001', 'manual-payer@bills.example');

set role authenticated;
set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000001';

-- No INSERT policy on `bills` at all: a direct client insert is denied, same no-policy default
-- deny as every other table before its policies land.
select throws_ok(
  $$ insert into public.bills (payer_user_id) values ('d1000000-0000-0000-0000-000000000001') $$,
  'new row violates row-level security policy for table "bills"',
  'a direct insert into bills is still denied for a normal signed-in user'
);

select lives_ok(
  $$ select public.create_manual_bill() $$,
  'a signed-in, non-anonymous user can create a manual draft bill through the RPC'
);

select results_eq(
  $$ select payer_user_id, status from public.bills
     where payer_user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  $$ values ('d1000000-0000-0000-0000-000000000001'::uuid, 'draft'::text) $$,
  'the created bill is owned by the caller and starts as a draft'
);

select results_eq(
  $$ select count(*)::int from public.bill_people bp
     join public.bills b on b.id = bp.bill_id
     where b.payer_user_id = 'd1000000-0000-0000-0000-000000000001'
       and bp.kind = 'payer' and bp.user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  $$ values (1) $$,
  'handle_new_bill still gives the manual-entry payer their own bill_people row'
);

-- Calling it twice makes two separate bills (manual entry has no idempotency key - each call is a
-- fresh "Enter manually" tap).
select lives_ok(
  $$ select public.create_manual_bill() $$,
  'a second call creates a second, separate draft bill'
);

select results_eq(
  $$ select count(*)::int from public.bills
     where payer_user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  $$ values (2) $$,
  'two calls leave two distinct bills behind'
);

-- An anonymous session (a guest, who never pays for a bill) cannot call it.
reset request.jwt.claim.sub;
set request.jwt.claims = '{"sub": "d1000000-0000-0000-0000-000000000002", "is_anonymous": true}';

select throws_ok(
  $$ select public.create_manual_bill() $$,
  'create_manual_bill requires a non-anonymous session',
  'an anonymous session cannot create a manual bill'
);

-- No session at all (the public anon key, unauthenticated).
reset request.jwt.claims;
reset role;
set role anon;

select throws_ok(
  $$ select public.create_manual_bill() $$,
  'create_manual_bill requires a signed-in session',
  'a caller with no session at all cannot create a manual bill'
);

select is_empty(
  $$ select 1 from public.bills where payer_user_id is null $$,
  'no bill was ever created with a null payer'
);

reset role;
select * from finish();
rollback;
