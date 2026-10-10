-- pgTAP coverage for the `push_tokens` RLS policy and the `register_push_token` RPC (SPEC.md
-- 8.1/8.2, AGENTS.md "every policy has a pgTAP test"): a signed-in user can insert, read, update,
-- and delete their own row(s) directly against the table (not just through the SECURITY DEFINER
-- RPC, which bypasses RLS and so proves nothing about the policies themselves); another signed-in
-- user can't read, insert, update, or delete them; and the RPC reassigns a token that already
-- belongs to someone else instead of raising or no-op'ing.
begin;
select plan(15);

insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'owner@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'intruder@example.com');

-- Acting as the owner: can insert, read, update, and delete their own row(s) directly.
set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

select lives_ok(
  $$ insert into public.push_tokens (user_id, token, platform)
     values ('55555555-5555-5555-5555-555555555555', 'ExponentPushToken[owner-device-1]', 'ios') $$,
  'owner can insert their own push token row'
);

select results_eq(
  $$ select platform from public.push_tokens where user_id = '55555555-5555-5555-5555-555555555555' $$,
  $$ values ('ios'::text) $$,
  'owner can read their own push token row'
);

select lives_ok(
  $$ update public.push_tokens set platform = 'android'
     where token = 'ExponentPushToken[owner-device-1]' $$,
  'owner can update their own push token row directly (push_tokens_update_own''s allow case)'
);

select results_eq(
  $$ select platform from public.push_tokens where token = 'ExponentPushToken[owner-device-1]' $$,
  $$ values ('android'::text) $$,
  'the owner''s direct update actually took effect'
);

select lives_ok(
  $$ insert into public.push_tokens (user_id, token, platform)
     values ('55555555-5555-5555-5555-555555555555', 'ExponentPushToken[owner-device-2]', 'ios') $$,
  'owner can insert a second push token row (a second device)'
);

select lives_ok(
  $$ delete from public.push_tokens where token = 'ExponentPushToken[owner-device-2]' $$,
  'owner can delete their own push token row directly (push_tokens_delete_own''s allow case)'
);

select is_empty(
  $$ select 1 from public.push_tokens where token = 'ExponentPushToken[owner-device-2]' $$,
  'the owner''s direct delete actually took effect'
);

-- Acting as the intruder: the owner's remaining row is invisible and unreachable, by any of the
-- four verbs.
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';

select is_empty(
  $$ select 1 from public.push_tokens where user_id = '55555555-5555-5555-5555-555555555555' $$,
  'intruder cannot read another user''s push token row'
);

select throws_ok(
  $$ insert into public.push_tokens (user_id, token, platform)
     values ('55555555-5555-5555-5555-555555555555', 'ExponentPushToken[intruder-forged]', 'ios') $$,
  'new row violates row-level security policy for table "push_tokens"',
  'intruder cannot insert a push token row for another user'
);

select is_empty(
  $$ update public.push_tokens set platform = 'ios'
     where user_id = '55555555-5555-5555-5555-555555555555'
     returning platform $$,
  'intruder cannot update another user''s push token row'
);

select is_empty(
  $$ delete from public.push_tokens
     where user_id = '55555555-5555-5555-5555-555555555555'
     returning 1 $$,
  'intruder cannot delete another user''s push token row'
);

-- `register_push_token`: a caller can only register a token for themselves, even via the RPC.
select throws_ok(
  $$ select public.register_push_token('55555555-5555-5555-5555-555555555555', 'ExponentPushToken[intruder-steal]', 'ios') $$,
  'register_push_token: can only register a push token for yourself',
  'intruder cannot call register_push_token to claim a token under another user''s id'
);

-- Reassignment: a device whose token already belongs to the owner changes hands to the intruder
-- (SPEC's friend-group premise makes this plausible) - the RPC moves the row to the new caller
-- instead of raising an RLS error or silently failing, the way a plain client-side
-- `upsert(..., { onConflict: 'token' })` would under self-row-only RLS.
select lives_ok(
  $$ select public.register_push_token('66666666-6666-6666-6666-666666666666', 'ExponentPushToken[owner-device-1]', 'android') $$,
  'intruder can register_push_token for themselves, reassigning a token the owner previously held'
);

select results_eq(
  $$ select user_id, platform from public.push_tokens where token = 'ExponentPushToken[owner-device-1]' $$,
  $$ values ('66666666-6666-6666-6666-666666666666'::uuid, 'android'::text) $$,
  'the reassigned row now belongs to the new caller with the new platform'
);

-- The original owner can no longer see it, same as any other row they don't own.
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

select is_empty(
  $$ select 1 from public.push_tokens where token = 'ExponentPushToken[owner-device-1]' $$,
  'the original owner can no longer read the reassigned token row'
);

reset role;
select * from finish();
rollback;
