-- pgTAP coverage for `search_usernames` (SPEC.md 8.2 "Username search"): matches by prefix,
-- requires at least 2 characters, returns at most 10 rows, requires a session (it's `security
-- definer`, so without this check the public anon key could scrape every username), and treats
-- `%`/`_` in the caller's prefix as literal characters rather than LIKE wildcards.
begin;
select plan(7);

insert into auth.users (id, email)
select
  ('c9000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'user' || n || '@search.example'
from generate_series(1, 12) as n;

-- Eleven usernames starting with "al", one that doesn't, to check both prefix matching and the
-- 10-row cap.
with alpha as (
  select id, row_number() over (order by id) as rn
  from public.profiles
  where id::text like 'c9000000%'
  order by id
  limit 11
)
update public.profiles p
set username = 'al' || lpad(alpha.rn::text, 2, '0')
from alpha
where p.id = alpha.id;

update public.profiles set username = 'bob01'
where id::text like 'c9000000%' and username is null;

set role authenticated;
set request.jwt.claim.sub = 'c9000000-0000-0000-0000-000000000001';

select results_eq(
  $$ select count(*)::int from public.search_usernames('bo') $$,
  $$ values (1) $$,
  'matches a prefix'
);

select is_empty(
  $$ select 1 from public.search_usernames('b') $$,
  'rejects a prefix shorter than 2 characters'
);

select is_empty(
  $$ select 1 from public.search_usernames('zz') $$,
  'returns nothing for a prefix with no match'
);

select results_eq(
  $$ select count(*)::int from public.search_usernames('al') $$,
  $$ values (10) $$,
  'caps results at 10 rows'
);

-- `_` is a LIKE wildcard matching any single character; escaped, "b_b" must not match "bob01"
-- even though an unescaped ilike('b_b%') would.
select is_empty(
  $$ select 1 from public.search_usernames('b_b') $$,
  'treats an underscore in the prefix as a literal character, not a wildcard'
);

-- Usernames can never contain a literal backslash (the format constraint on `profiles.username`
-- is `[a-z0-9_]`), so this can't prove a match either way - it's a robustness check that a
-- prefix containing one doesn't error out, which it would if the backslash weren't escaped
-- before `%`/`_` are (a dangling, unpaired escape character makes the LIKE pattern invalid).
select lives_ok(
  $$ select 1 from public.search_usernames('bo\') $$,
  'a prefix containing a backslash does not error'
);

-- No session at all (the public anon key, unauthenticated): rejected outright, so it can't be
-- used to scrape usernames two characters at a time.
reset request.jwt.claim.sub;
reset role;
set role anon;

select throws_ok(
  $$ select public.search_usernames('al') $$,
  'search_usernames requires a session (signed in or anonymous)',
  'a caller with no session cannot search usernames'
);

reset role;
select * from finish();
rollback;
