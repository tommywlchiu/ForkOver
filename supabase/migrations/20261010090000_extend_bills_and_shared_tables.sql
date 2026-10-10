-- SPEC.md 8.1: the real multi-person schema behind a bill (M4). Extends the M3 `bills` table to
-- its full shape and adds the six tables that carry people, items, fees, claims, assignments, and
-- payment marks. RLS and triggers (SPEC 8.2) are a separate migration so this one is schema only.
--
-- No client code, realtime sync, or claim UI lands with this: this is the blocking schema piece
-- the rest of M4 (dispatched separately) builds on.

create extension if not exists pgcrypto with schema extensions;

-- At least 128 random bits, base64url encoded (SPEC 8.1, NFR-6). 16 random bytes is exactly 128
-- bits; `translate` turns standard base64 into base64url (`+`/`/` -> `-`/`_`) and drops the `=`
-- padding (mapped to nothing because the third argument is shorter than the first).
create function public.generate_share_token()
returns text
language sql
as $$
  select translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', '-_');
$$;

-- Shared `updated_at` bump, reused by every table below that has the column.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- --- bills: extend from the M3 shape (id, payer_user_id, status, receipt_path, created_at) -----

alter table public.bills
  add column share_token text,
  add column title text,
  add column merchant_name text,
  add column currency text not null default 'USD',
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  add column tax_cents integer not null default 0 check (tax_cents >= 0),
  add column tip jsonb,
  add column receipt_expires_at timestamptz,
  add column sent_at timestamptz,
  add column closed_at timestamptz,
  add column updated_at timestamptz not null default now();

-- Backfill any pre-existing rows (there are none outside tests) before enforcing not-null/unique.
update public.bills set share_token = public.generate_share_token() where share_token is null;

alter table public.bills
  alter column share_token set not null,
  alter column share_token set default public.generate_share_token();

create unique index bills_share_token_key on public.bills (share_token);

create trigger bills_set_updated_at
  before update on public.bills
  for each row execute function public.set_updated_at();

-- --- bill_people --------------------------------------------------------------------------------

create table public.bill_people (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  display_name text not null,
  kind text not null check (kind in ('payer', 'member', 'guest', 'named')),
  joined_at timestamptz not null default now(),
  unique (bill_id, user_id)
);

alter table public.bill_people enable row level security;

-- Every bill gets its payer as a `bill_people` row the moment it's created, so `claims.created_by`
-- (a `bill_people` id) always has something to point at when the payer claims on someone else's
-- behalf (FR-32), without `join_bill` needing a special case for the payer visiting their own link.
create function public.handle_new_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bill_people (bill_id, user_id, display_name, kind)
  values (
    new.id,
    new.payer_user_id,
    coalesce((select display_name from public.profiles where id = new.payer_user_id), 'Payer'),
    'payer'
  );
  return new;
end;
$$;

create trigger on_bill_created
  after insert on public.bills
  for each row execute function public.handle_new_bill();

-- --- bill_items ----------------------------------------------------------------------------------

create table public.bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  position integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bill_items enable row level security;

create trigger bill_items_set_updated_at
  before update on public.bill_items
  for each row execute function public.set_updated_at();

-- --- bill_fees -----------------------------------------------------------------------------------

create table public.bill_fees (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  label text not null,
  cents integer not null,
  split text not null check (split in ('proportional', 'equal'))
);

alter table public.bill_fees enable row level security;

-- --- claims ---------------------------------------------------------------------------------------

create table public.claims (
  item_id uuid not null references public.bill_items (id) on delete cascade,
  person_id uuid not null references public.bill_people (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  mode text not null check (mode in ('mine', 'shared')),
  created_by uuid not null references public.bill_people (id),
  created_at timestamptz not null default now(),
  primary key (item_id, person_id)
);

alter table public.claims enable row level security;

-- --- assignments ---------------------------------------------------------------------------------

create table public.assignments (
  item_id uuid primary key references public.bill_items (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  assigned_to uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.assignments enable row level security;

create trigger assignments_set_updated_at
  before update on public.assignments
  for each row execute function public.set_updated_at();

-- --- payments --------------------------------------------------------------------------------------

create table public.payments (
  item_id uuid not null references public.bill_items (id) on delete cascade,
  person_id uuid not null references public.bill_people (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  marked_at timestamptz not null default now(),
  primary key (item_id, person_id)
);

alter table public.payments enable row level security;
