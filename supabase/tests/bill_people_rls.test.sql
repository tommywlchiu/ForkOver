-- pgTAP coverage for `bill_people`'s M4 policies and `join_bill` (SPEC.md 8.2 "Membership",
-- "Joining", "Payer only"): a signed-in user joins as a member, an anonymous session joins as a
-- guest, joining again returns the same row, closed bills reject joining, and only the payer can
-- add or edit a named person directly.
begin;
select plan(13);

insert into auth.users (id, email) values
  ('c1000000-0000-0000-0000-000000000001', 'payer@people.example'),
  ('c1000000-0000-0000-0000-000000000002', 'member@people.example'),
  ('c1000000-0000-0000-0000-000000000003', 'guest@people.example'),
  ('c1000000-0000-0000-0000-000000000004', 'outsider@people.example');

-- Explicit share_token values (rather than the generated default) so the tests below can pass
-- them to join_bill directly: a real caller has the token from the share link URL itself, not
-- from querying `bills` (which they can't do yet - they aren't a member until they join).
insert into public.bills (id, payer_user_id, status, share_token)
values ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'open', 'open-bill-share-token');

insert into public.bills (id, payer_user_id, status, share_token)
values ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'closed', 'closed-bill-share-token');

set role authenticated;

-- A signed-in user joins as a member.
set request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000002';

select results_eq(
  $$ select kind from public.join_bill(
       'open-bill-share-token',
       'Riley'
     ) $$,
  $$ values ('member'::text) $$,
  'a signed-in user joins as a member'
);

select results_eq(
  $$ select count(*)::int from public.bill_people
     where bill_id = 'c2000000-0000-0000-0000-000000000001'
       and user_id = 'c1000000-0000-0000-0000-000000000002' $$,
  $$ values (1) $$,
  'joining creates exactly one bill_people row'
);

select results_eq(
  $$ select display_name from public.join_bill(
       'open-bill-share-token',
       'A different name'
     ) $$,
  $$ values ('Riley'::text) $$,
  'joining again returns the existing row unchanged'
);

-- An anonymous session joins as a guest. `auth.uid()` prefers the per-claim `request.jwt.claim.sub`
-- GUC over the full `request.jwt.claims` JSON, so it must be cleared first or it'd still resolve
-- to the previous (member) user.
reset request.jwt.claim.sub;
set request.jwt.claims = '{"sub": "c1000000-0000-0000-0000-000000000003", "is_anonymous": true}';

select results_eq(
  $$ select kind from public.join_bill(
       'open-bill-share-token',
       'Guest Sam'
     ) $$,
  $$ values ('guest'::text) $$,
  'an anonymous session joins as a guest'
);

reset request.jwt.claims;
reset role;
set role authenticated;
set request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000004';

select throws_ok(
  $$ select public.join_bill(
       'closed-bill-share-token',
       'Too Late'
     ) $$,
  'this bill is closed',
  'joining a closed bill is rejected'
);

select throws_ok(
  $$ select public.join_bill(
       'open-bill-share-token',
       ''
     ) $$,
  'display_name must be 1 to 30 characters',
  'joining with an empty display name is rejected'
);

-- Payer-only direct inserts/updates of named people.
set request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ insert into public.bill_people (id, bill_id, display_name, kind)
     values (
       'c3000000-0000-0000-0000-000000000001',
       'c2000000-0000-0000-0000-000000000001',
       'Phone Died Pat',
       'named'
     ) $$,
  'the payer can add a named person'
);

select lives_ok(
  $$ update public.bill_people set display_name = 'Pat'
     where id = 'c3000000-0000-0000-0000-000000000001' $$,
  'the payer can edit a named person'
);

-- bill_id is immutable after creation, even for the payer moving a named person between two
-- bills they own.
select throws_ok(
  $$ update public.bill_people set bill_id = 'c2000000-0000-0000-0000-000000000002'
     where id = 'c3000000-0000-0000-0000-000000000001' $$,
  'bill_people.bill_id cannot be changed after creation',
  'moving a named person to another bill is rejected'
);

set request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.bill_people (bill_id, display_name, kind)
     values ('c2000000-0000-0000-0000-000000000001', 'Sneaky', 'named') $$,
  'new row violates row-level security policy for table "bill_people"',
  'a non-payer member cannot add a named person'
);

select is_empty(
  $$ update public.bill_people set display_name = 'Hacked'
     where id = 'c3000000-0000-0000-0000-000000000001'
     returning display_name $$,
  'a non-payer member cannot edit a named person'
);

-- Membership read.
select results_eq(
  $$ select count(*)::int from public.bill_people where bill_id = 'c2000000-0000-0000-0000-000000000001' $$,
  $$ values (4) $$,
  'a member can read the bill''s people (payer, self, guest, named)'
);

set request.jwt.claim.sub = 'c1000000-0000-0000-0000-000000000004';

select is_empty(
  $$ select 1 from public.bill_people where bill_id = 'c2000000-0000-0000-0000-000000000001' $$,
  'an outsider cannot read the bill''s people'
);

reset role;
select * from finish();
rollback;
