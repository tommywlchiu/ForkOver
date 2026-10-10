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
