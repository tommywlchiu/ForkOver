-- pgTAP coverage for the `push_tokens` RLS policy (SPEC.md 8.1/8.2, AGENTS.md "every policy has a
-- pgTAP test"): a signed-in user can upsert and read their own row(s); another signed-in user
-- cannot read or write them.
begin;
select plan(5);

insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'owner@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'intruder@example.com');

-- Acting as the owner: can insert (upsert) their own token row.
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

-- Upsert on conflict (token unique): re-registering the same device updates in place.
select lives_ok(
  $$ insert into public.push_tokens (user_id, token, platform)
     values ('55555555-5555-5555-5555-555555555555', 'ExponentPushToken[owner-device-1]', 'android')
     on conflict (token) do update set platform = excluded.platform, updated_at = now() $$,
  'owner can upsert their own push token row on conflict'
);

-- Acting as the intruder: the owner's row is invisible and unreachable.
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

reset role;
select * from finish();
rollback;
