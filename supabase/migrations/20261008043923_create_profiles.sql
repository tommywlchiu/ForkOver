-- SPEC.md 8.1 / 8.2: profiles table and its RLS policy.
--
-- Row creation: a trigger on `auth.users` inserts a bare `profiles` row (id only) right after
-- Supabase Auth creates the user, following Supabase's standard "handle_new_user" pattern. This
-- keeps every signed-in user owning exactly one profile row from the moment they exist, without
-- the client racing to insert it itself (and without needing an INSERT policy for users, since the
-- trigger function runs as SECURITY DEFINER and bypasses RLS). `username`/`display_name`/
-- `venmo_username` start null and are filled in by the username screen (M3 part 1) via UPDATE.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  display_name text,
  venmo_username text,
  ai_consent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint profiles_username_format check (
    username is null or username ~ '^[a-z0-9_]{3,20}$'
  )
);

-- Case-insensitive uniqueness (SPEC 13 default 16): two users can't take "Alex" and "alex".
create unique index profiles_username_lower_key on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- SPEC 8.2: a user reads and writes only their own row.
create policy "profiles_select_own" on public.profiles
  for select
  using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Creates the bare profile row for a new auth user. SECURITY DEFINER so it can insert despite RLS.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
