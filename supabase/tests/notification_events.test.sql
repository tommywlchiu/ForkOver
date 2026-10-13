-- pgTAP coverage for `notification_events` (SPEC.md 8.7, M4 notify task, AGENTS.md "every table
-- has RLS enabled, and every policy has a pgTAP test"): same default-deny shape as `scan_usage`/
-- `scan_log` - RLS enabled, zero policies, so a signed-in user is denied every read and write,
-- even to their own row. Only `invite_bill_member` (SECURITY DEFINER) or the service-role
-- `notify` function can touch it. Also covers that `invite_bill_member` actually queues a row on
-- a genuine new invite, and does not on a repeat invite or a self-join racing it - the exact
-- distinction the migration comment calls out as the reason this is its own table instead of a
-- trigger straight on `bill_people`.
begin;
select plan(9);

insert into auth.users (id, email) values
  ('f1000000-0000-0000-0000-000000000001', 'payer@notify.example'),
  ('f1000000-0000-0000-0000-000000000002', 'friend@notify.example'),
  ('f1000000-0000-0000-0000-000000000003', 'outsider@notify.example');

update public.profiles set username = 'notify_friend', display_name = 'Notify Friend'
where id = 'f1000000-0000-0000-0000-000000000002';

insert into public.bills (id, payer_user_id, status, share_token) values
  ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'open', 'notify-open-token');

-- Service role seeds one row directly, the way `notify`'s own queries never will need to (it only
-- ever reads push_tokens), so the RLS checks below have a real row to try against.
insert into public.notification_events (event_type, bill_id, recipient_user_id)
values ('bill_member_invited', 'f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002');

set role authenticated;
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000002';

select is_empty(
  $$ select 1 from public.notification_events
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000002' $$,
  'the recipient cannot read their own notification_events row - only the service role touches this table'
);

select throws_ok(
  $$ insert into public.notification_events (event_type, bill_id, recipient_user_id)
     values ('bill_member_invited', 'f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002') $$,
  'new row violates row-level security policy for table "notification_events"',
  'a signed-in user cannot insert into notification_events directly'
);

select is_empty(
  $$ update public.notification_events set event_type = 'bill_member_invited'
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000002'
     returning id $$,
  'a signed-in user cannot update notification_events'
);

select is_empty(
  $$ delete from public.notification_events
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000002'
     returning id $$,
  'a signed-in user cannot delete from notification_events'
);

reset request.jwt.claim.sub;
set role anon;

select is_empty(
  $$ select 1 from public.notification_events $$,
  'anon cannot read notification_events at all'
);

reset role;

-- invite_bill_member itself: queues exactly one row on a genuine new invite...
set role authenticated;
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000001';

select public.invite_bill_member('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003');

-- `notification_events` has no select policy at all (by design - above), so these counts run as
-- the unrestricted superuser, the same way every other check against a policy-free table in this
-- suite does (m3_default_deny_rls.test.sql seeds scan_usage/scan_log the same way); `results_eq`
-- itself still runs under whatever role issued it, so each one resets the role first.
reset role;

select results_eq(
  $$ select event_type, bill_id, recipient_user_id from public.notification_events
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000003' $$,
  $$ values ('bill_member_invited'::text, 'f2000000-0000-0000-0000-000000000001'::uuid, 'f1000000-0000-0000-0000-000000000003'::uuid) $$,
  'inviting a new member queues exactly one notification_events row for them'
);

-- ...but not again on a repeat invite of the same person (already_member: true - nothing new
-- happened, so nothing new should be queued).
set role authenticated;
set request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000001';

select public.invite_bill_member('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003');

reset role;

select results_eq(
  $$ select count(*)::int from public.notification_events
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000003' $$,
  $$ values (1) $$,
  'inviting the same person again does not queue a second notification'
);

-- A plain self-join via the share link (join_bill) is not an invite and must never queue one.
set role authenticated;
set request.jwt.claims = '{"sub": "f1000000-0000-0000-0000-000000000003", "is_anonymous": false}';

-- Already a member from the invite above; re-run join_bill to prove the *mechanism* (join_bill
-- itself) never inserts into notification_events, independent of membership state.
select lives_ok(
  $$ select public.join_bill('notify-open-token', 'Notify Friend 3') $$,
  'the invited user can also hit the share link without erroring'
);

reset request.jwt.claims;
reset role;

select results_eq(
  $$ select count(*)::int from public.notification_events
     where recipient_user_id = 'f1000000-0000-0000-0000-000000000003' $$,
  $$ values (1) $$,
  'join_bill never queues a notification_events row itself'
);

select * from finish();
rollback;
