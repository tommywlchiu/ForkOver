-- SPEC.md 8.1/8.2: `push_tokens` table, so the (later) `notify` function has somewhere to send
-- to. Self-row only, the same shape as `profiles` (AGENTS.md): a user reads and writes only their
-- own rows. One user can have several rows (one per device), each a unique Expo push token.

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- SPEC 8.2: a user reads and writes only their own row (same shape as `profiles`).
create policy "push_tokens_select_own" on public.push_tokens
  for select
  using (auth.uid() = user_id);

create policy "push_tokens_insert_own" on public.push_tokens
  for insert
  with check (auth.uid() = user_id);

create policy "push_tokens_update_own" on public.push_tokens
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "push_tokens_delete_own" on public.push_tokens
  for delete
  using (auth.uid() = user_id);

-- A plain client-side `insert ... on conflict (token) do update` can't register a token that
-- already belongs to a *different* user (a shared device, or one that changes hands, both
-- plausible given SPEC's friend-group premise): the conflicting row fails
-- `push_tokens_update_own`'s `USING (auth.uid() = user_id)` for the new caller, and
-- `ON CONFLICT DO UPDATE` raises an RLS error there rather than silently skipping, and the new
-- user has no rights to touch the old owner's row at all, even to delete it, under self-row-only
-- RLS. This SECURITY DEFINER RPC does the reassignment atomically instead: it bypasses RLS (that
-- is what SECURITY DEFINER is for) but re-checks the same self-row rule itself (`auth.uid() =
-- p_user_id`), so a caller can still only ever register a token for themselves.
create function public.register_push_token(p_user_id uuid, p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'register_push_token: can only register a push token for yourself';
  end if;
  if p_platform not in ('ios', 'android') then
    raise exception 'register_push_token: invalid platform %', p_platform;
  end if;

  insert into public.push_tokens (user_id, token, platform, updated_at)
  values (p_user_id, p_token, p_platform, now())
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.register_push_token(uuid, text, text) from public;
grant execute on function public.register_push_token(uuid, text, text) to authenticated;
