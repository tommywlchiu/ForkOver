-- pgTAP coverage for `invite_bill_member` (SPEC.md 8.2/8.5, M4 in-app-sending task): the payer can
-- invite a specific, known user as a real `kind = 'member'` bill_people row; a non-payer can't;
-- inviting twice (or inviting someone who already joined themselves) is idempotent and honestly
-- reports `already_member`, rather than lying about creating a fresh row; and it's blocked on a
-- closed bill, same as every other payer-only write.
begin;
select plan(12);

insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-000000000001', 'payer@invite.example'),
  ('e1000000-0000-0000-0000-000000000002', 'other-payer@invite.example'),
  ('e1000000-0000-0000-0000-000000000003', 'friend@invite.example'),
  ('e1000000-0000-0000-0000-000000000004', 'outsider@invite.example'),
  ('e1000000-0000-0000-0000-000000000005', 'already-guest@invite.example');

update public.profiles set username = 'friend_a', display_name = 'Friend A'
where id = 'e1000000-0000-0000-0000-000000000003';

update public.profiles set username = 'guest_g', display_name = 'Guest G'
where id = 'e1000000-0000-0000-0000-000000000005';

insert into public.bills (id, payer_user_id, status, share_token) values
  ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'open', 'invite-open-token'),
  ('e2000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'closed', 'invite-closed-token');

set role authenticated;

-- A user who already joined themselves as a guest via the share link, before the payer ever
-- tries to invite them by username.
set request.jwt.claims = '{"sub": "e1000000-0000-0000-0000-000000000005", "is_anonymous": true}';

select lives_ok(
  $$ select public.join_bill('invite-open-token', 'Guest G') $$,
  'the eventual invitee joins first as a guest, via the share link'
);

reset request.jwt.claims;
set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';

select results_eq(
  $$ select kind, display_name from public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e1000000-0000-0000-0000-000000000003'
     ) $$,
  $$ values ('member'::text, 'Friend A'::text) $$,
  'the payer can invite a specific, known user as a member'
);

select results_eq(
  $$ select count(*)::int from public.bill_people
     where bill_id = 'e2000000-0000-0000-0000-000000000001'
       and user_id = 'e1000000-0000-0000-0000-000000000003'
       and kind = 'member' $$,
  $$ values (1) $$,
  'inviting creates exactly one bill_people row'
);

-- Calling it again for the same user does not create a duplicate row (idempotent, like
-- join_bill), and honestly reports it via `already_member` rather than claiming a fresh invite.
select results_eq(
  $$ select id, already_member from public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e1000000-0000-0000-0000-000000000003'
     ) $$,
  $$ select id, true from public.bill_people
     where bill_id = 'e2000000-0000-0000-0000-000000000001'
       and user_id = 'e1000000-0000-0000-0000-000000000003' $$,
  'inviting the same person twice returns the existing row, flagged already_member'
);

select results_eq(
  $$ select count(*)::int from public.bill_people
     where bill_id = 'e2000000-0000-0000-0000-000000000001'
       and user_id = 'e1000000-0000-0000-0000-000000000003' $$,
  $$ values (1) $$,
  'calling it twice still leaves exactly one row behind'
);

-- Inviting someone who already joined themselves as a guest is also reported as
-- `already_member`, and their kind is left exactly as it was (no silent 'guest' -> 'member'
-- upgrade) - a full identity merge is out of scope here (see the migration's own comment).
select results_eq(
  $$ select kind, already_member from public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e1000000-0000-0000-0000-000000000005'
     ) $$,
  $$ values ('guest'::text, true) $$,
  'inviting an already-joined guest reports already_member and leaves their kind unchanged'
);

-- A non-payer (even one who owns a different bill) cannot invite anyone to this bill.
set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e1000000-0000-0000-0000-000000000004'
     ) $$,
  'invite_bill_member: only the bill''s payer may invite a member',
  'a non-payer cannot invite a member'
);

select is_empty(
  $$ select 1 from public.bill_people
     where bill_id = 'e2000000-0000-0000-0000-000000000001'
       and user_id = 'e1000000-0000-0000-0000-000000000004' $$,
  'the rejected invite never created a row'
);

-- Closed bills are read-only (SPEC 8.5), same as every other payer-only write.
set request.jwt.claim.sub = 'e1000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ select public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000002',
       'e1000000-0000-0000-0000-000000000003'
     ) $$,
  'invite_bill_member: bill e2000000-0000-0000-0000-000000000002 is closed',
  'the payer cannot invite a member to a closed bill'
);

-- The payer cannot invite themselves (they already have a 'payer' row).
select throws_ok(
  $$ select public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e1000000-0000-0000-0000-000000000001'
     ) $$,
  'invite_bill_member: the payer cannot invite themselves',
  'the payer cannot invite themselves'
);

-- No profile at all for the given user id.
select throws_ok(
  $$ select public.invite_bill_member(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000099'
     ) $$,
  'invite_bill_member: no profile found for user e3000000-0000-0000-0000-000000000099',
  'inviting a nonexistent user is rejected'
);

-- No bill at all for the given id.
select throws_ok(
  $$ select public.invite_bill_member(
       'e4000000-0000-0000-0000-000000000099',
       'e1000000-0000-0000-0000-000000000003'
     ) $$,
  'no bill found for id e4000000-0000-0000-0000-000000000099',
  'inviting to a nonexistent bill is rejected'
);

reset role;
select * from finish();
rollback;
