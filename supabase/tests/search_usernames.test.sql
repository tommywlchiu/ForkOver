-- pgTAP coverage for `search_usernames` (SPEC.md 8.2 "Username search"): matches by prefix,
-- requires at least 2 characters, and returns at most 10 rows.
begin;
select plan(4);

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

reset role;
select * from finish();
rollback;
