-- pgTAP coverage for the `profiles` RLS policy (SPEC.md 8.2, AGENTS.md "every policy has a
-- pgTAP test"): a signed-in user can read and update their own row; another signed-in user
-- cannot read or update it.
begin;
select plan(4);

-- Two auth users, created directly (bypassing the Auth API) so the `on_auth_user_created`
-- trigger fires and gives each one a bare profiles row.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'intruder@example.com');

update public.profiles set username = 'owner_user' where id = '11111111-1111-1111-1111-111111111111';

-- Acting as the owner: can see and update their own row.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$ select username from public.profiles where id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values ('owner_user'::text) $$,
  'owner can read their own profile row'
);

select lives_ok(
  $$ update public.profiles set display_name = 'Owner' where id = '11111111-1111-1111-1111-111111111111' $$,
  'owner can update their own profile row'
);

-- Acting as the intruder: the owner's row is invisible and unreachable.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select is_empty(
  $$ select 1 from public.profiles where id = '11111111-1111-1111-1111-111111111111' $$,
  'intruder cannot read another user''s profile row'
);

-- An UPDATE with no visible matching row affects nothing, rather than erroring.
select is_empty(
  $$ update public.profiles set display_name = 'Hacked'
     where id = '11111111-1111-1111-1111-111111111111'
     returning display_name $$,
  'intruder cannot update another user''s profile row'
);

reset role;
select * from finish();
rollback;
