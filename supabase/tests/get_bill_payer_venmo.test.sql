-- pgTAP coverage for `get_bill_payer_venmo` (SPEC.md 2.3 step 4, 6.6): a bill member (payer,
-- member, or guest) can read the payer's Venmo username through this RPC even though
-- `profiles_select_own` would otherwise block them from reading the payer's profile row directly;
-- a bill with no Venmo username set returns null, and so does an outsider.
begin;
select plan(4);

insert into auth.users (id, email) values
  ('d1000000-0000-0000-0000-000000000001', 'payer@venmo.example'),
  ('d1000000-0000-0000-0000-000000000002', 'member@venmo.example'),
  ('d1000000-0000-0000-0000-000000000003', 'outsider@venmo.example'),
  ('d1000000-0000-0000-0000-000000000004', 'no-venmo-payer@venmo.example');

update public.profiles set venmo_username = 'payer-venmo'
where id = 'd1000000-0000-0000-0000-000000000001';

insert into public.bills (id, payer_user_id, status, share_token)
values ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'open', 'venmo-bill-token');

-- A different payer, who never set a Venmo username (`profiles.venmo_username` stays null).
insert into public.bills (id, payer_user_id, status, share_token)
values ('d2000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000004', 'open', 'no-venmo-bill-token');

insert into public.bill_people (bill_id, user_id, display_name, kind)
values ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'Riley', 'member');

set role authenticated;

set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000002';
select results_eq(
  $$ select public.get_bill_payer_venmo('d2000000-0000-0000-0000-000000000001') $$,
  $$ values ('payer-venmo'::text) $$,
  'a member can read the payer''s Venmo username through the RPC'
);

set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000004';
select is(
  (select public.get_bill_payer_venmo('d2000000-0000-0000-0000-000000000002')),
  null,
  'a bill whose payer has no Venmo username on it returns null, not an error'
);

set request.jwt.claim.sub = 'd1000000-0000-0000-0000-000000000003';
select is(
  (select public.get_bill_payer_venmo('d2000000-0000-0000-0000-000000000001')),
  null,
  'an outsider (not a member of this bill) gets null rather than the payer''s Venmo username'
);

select is(
  (select public.get_bill_payer_venmo('00000000-0000-0000-0000-000000000000')),
  null,
  'a nonexistent bill id returns null rather than erroring'
);

reset role;
select * from finish();
rollback;
