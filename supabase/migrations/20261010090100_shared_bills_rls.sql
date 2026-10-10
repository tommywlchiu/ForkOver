-- SPEC.md 8.2: access rules for the M4 shared-bill tables added in the previous migration.
--
-- Helper functions are `security definer` so a policy on one table can safely consult another
-- (e.g. `bills`' own select policy checking `bill_people`) without recursing back through RLS or
-- requiring every table's policies to line up with each other. They are `stable` so the planner
-- can evaluate them once per statement rather than once per row.

-- A user can read a bill (and, transitively, its rows) if they are its payer or have a
-- `bill_people` row with their `user_id` (SPEC 8.2 "Membership").
create function public.is_bill_member(p_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bills b
    where b.id = p_bill_id
      and (
        b.payer_user_id = auth.uid()
        or exists (
          select 1 from public.bill_people bp
          where bp.bill_id = b.id and bp.user_id = auth.uid()
        )
      )
  );
$$;

create function public.is_bill_payer(p_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bills b
    where b.id = p_bill_id and b.payer_user_id = auth.uid()
  );
$$;

-- Is the caller the `bill_people` row with this id (used for "a person can act for themselves").
create function public.is_own_bill_person(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bill_people bp
    where bp.id = p_person_id and bp.user_id = auth.uid()
  );
$$;

create function public.is_bill_closed(p_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bills b where b.id = p_bill_id and b.status = 'closed');
$$;

-- Shared by the claim/assignment/item lock triggers (SPEC 8.2 "Triggers"): true once the bill is
-- closed or the item has any paid portion. Factored out so a future change to the lock rule only
-- has one place to change, instead of several copy-pasted checks.
create function public.is_item_locked(p_item_id uuid, p_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_bill_closed(p_bill_id)
    or exists (select 1 from public.payments p where p.item_id = p_item_id);
$$;

-- --- bills ------------------------------------------------------------------------------------

create policy "bills_select_members" on public.bills
  for select
  using (public.is_bill_member(id));

-- Payer only: bill status and the receipt-level fields (title, tip, discount/tax, etc). Creating
-- a bill stays service-role only (the parse-receipt function), as in M3.
create policy "bills_update_payer" on public.bills
  for update
  using (public.is_bill_payer(id))
  with check (public.is_bill_payer(id));

-- RLS can't restrict which columns an UPDATE touches, only which rows - so the policy above, on
-- its own, would let the payer silently reassign `payer_user_id` (handing the whole bill to
-- someone else and locking themselves out) or regenerate `share_token` (changing the public
-- link). Both are identity/addressing fields, never part of the "bill status and receipt-level
-- fields" the payer is meant to edit, so block changing them (or `id`) outright.
create function public.guard_bills_immutable_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'bills.id cannot be changed';
  end if;
  if new.payer_user_id is distinct from old.payer_user_id then
    raise exception 'bills.payer_user_id cannot be changed';
  end if;
  if new.share_token is distinct from old.share_token then
    raise exception 'bills.share_token cannot be changed';
  end if;
  return new;
end;
$$;

create trigger bills_immutable_fields_guard
  before update on public.bills
  for each row execute function public.guard_bills_immutable_fields();

-- SPEC 8.5: "Closed bills are read-only except payment marks." Once a bill is closed, the payer
-- can still close/re-save it (status, sent_at, closed_at) and cosmetic fields (title,
-- merchant_name), but not the fields that feed the split math - changing any of these on a
-- closed bill would silently alter everyone's already-settled share.
create function public.guard_bills_closed_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'closed' and (
    new.discount_cents is distinct from old.discount_cents
    or new.tax_cents is distinct from old.tax_cents
    or new.tip is distinct from old.tip
    or new.currency is distinct from old.currency
  ) then
    raise exception 'bills locked: bill % is closed', old.id;
  end if;
  return new;
end;
$$;

create trigger bills_closed_lock_guard
  before update on public.bills
  for each row execute function public.guard_bills_closed_lock();

-- --- bill_people --------------------------------------------------------------------------------

create policy "bill_people_select_members" on public.bill_people
  for select
  using (public.is_bill_member(bill_id));

-- Members and guests join through `join_bill` (security definer, below), which bypasses this
-- policy entirely. The only direct insert this table allows is the payer adding a named person
-- (SPEC 8.2 "Payer only"). Blocked once the bill is closed (SPEC 8.5): adding or renaming a
-- named person after closing would change who the already-settled split names.
create policy "bill_people_insert_named_by_payer" on public.bill_people
  for insert
  with check (
    kind = 'named' and public.is_bill_payer(bill_id) and not public.is_bill_closed(bill_id)
  );

create policy "bill_people_update_named_by_payer" on public.bill_people
  for update
  using (kind = 'named' and public.is_bill_payer(bill_id))
  with check (
    kind = 'named' and public.is_bill_payer(bill_id) and not public.is_bill_closed(bill_id)
  );

-- `guard_immutable_bill_id` (defined with `bill_items` below, since that's the risk it was added
-- for) is applied to this table's trigger further down too: a named person's `bill_id` has the
-- same "moved to a bill the payer also owns, orphaning their claims" risk.

-- --- bill_items ----------------------------------------------------------------------------------

create policy "bill_items_select_members" on public.bill_items
  for select
  using (public.is_bill_member(bill_id));

create policy "bill_items_insert_payer" on public.bill_items
  for insert
  with check (public.is_bill_payer(bill_id));

create policy "bill_items_update_payer" on public.bill_items
  for update
  using (public.is_bill_payer(bill_id))
  with check (public.is_bill_payer(bill_id));

create policy "bill_items_delete_payer" on public.bill_items
  for delete
  using (public.is_bill_payer(bill_id));

-- FR-17 / SPEC 8.5: an item is locked - even for the payer - once the bill is closed or the item
-- has any paid portion. The policy above still lets the payer's INSERT/UPDATE/DELETE statement
-- through; this trigger is what actually enforces the lock at the database layer regardless of
-- who's asking. INSERT is included too: without it, the payer could add brand-new items to a
-- closed bill, which SPEC 8.5 ("closed bills are read-only") doesn't allow. A new item can't have
-- a payment yet, so `is_item_locked` only effectively checks the bill's closed status for
-- INSERT. `bill_id` itself can't change on UPDATE (see the immutability guard below), and the
-- generated `id` default is already populated by the time a BEFORE INSERT trigger sees NEW, so
-- it's safe to read both from either OLD or NEW here.
create function public.guard_bill_item_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid := coalesce(new.id, old.id);
  v_bill_id uuid := coalesce(new.bill_id, old.bill_id);
begin
  if public.is_item_locked(v_item_id, v_bill_id) then
    raise exception 'bill_items locked: item % is closed or has a paid portion', v_item_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger bill_items_lock_guard
  before insert or update or delete on public.bill_items
  for each row execute function public.guard_bill_item_lock();

-- An item's `bill_id` is immutable after creation: nothing in SPEC 8.1 asks for moving an item
-- between bills, and allowing it would let the payer silently orphan dependent `claims`/
-- `assignments`/`payments` rows (they'd keep the item's old `bill_id`, fail the consistency
-- checks on their own next write, and drop out of the realtime subscription filtered by bill_id -
-- SPEC 8.3). Reused for `bill_fees` and `bill_people` below, which have the same risk.
create function public.guard_immutable_bill_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.bill_id is distinct from old.bill_id then
    raise exception '%.bill_id cannot be changed after creation', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger bill_items_immutable_bill_id
  before update on public.bill_items
  for each row execute function public.guard_immutable_bill_id();

-- Applied to `bill_people` here (rather than up in that section) because `guard_immutable_bill_id`
-- has to exist first; only the payer's named-person UPDATE policy can reach this trigger at all.
create trigger bill_people_immutable_bill_id
  before update on public.bill_people
  for each row execute function public.guard_immutable_bill_id();

-- --- bill_fees -----------------------------------------------------------------------------------

create policy "bill_fees_select_members" on public.bill_fees
  for select
  using (public.is_bill_member(bill_id));

create policy "bill_fees_insert_payer" on public.bill_fees
  for insert
  with check (public.is_bill_payer(bill_id));

create policy "bill_fees_update_payer" on public.bill_fees
  for update
  using (public.is_bill_payer(bill_id))
  with check (public.is_bill_payer(bill_id));

create policy "bill_fees_delete_payer" on public.bill_fees
  for delete
  using (public.is_bill_payer(bill_id));

create trigger bill_fees_immutable_bill_id
  before update on public.bill_fees
  for each row execute function public.guard_immutable_bill_id();

-- SPEC 8.5: fees feed the split math directly, the same as items, so they're locked on a closed
-- bill too. Unlike items, a fee has no payments of its own to key a paid-portion lock off of -
-- only the bill's closed status matters here.
create function public.guard_bill_fees_closed_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill_id uuid := coalesce(new.bill_id, old.bill_id);
begin
  if public.is_bill_closed(v_bill_id) then
    raise exception 'bill_fees locked: bill % is closed', v_bill_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger bill_fees_closed_lock_guard
  before insert or update or delete on public.bill_fees
  for each row execute function public.guard_bill_fees_closed_lock();

-- --- claims ---------------------------------------------------------------------------------------

create policy "claims_select_members" on public.claims
  for select
  using (public.is_bill_member(bill_id));

-- SPEC 8.2 "Claims": a person acts for their own `bill_people` row; the payer can act for anyone
-- (FR-32).
create policy "claims_insert_self_or_payer" on public.claims
  for insert
  with check (public.is_own_bill_person(person_id) or public.is_bill_payer(bill_id));

create policy "claims_update_self_or_payer" on public.claims
  for update
  using (public.is_own_bill_person(person_id) or public.is_bill_payer(bill_id))
  with check (public.is_own_bill_person(person_id) or public.is_bill_payer(bill_id));

create policy "claims_delete_self_or_payer" on public.claims
  for delete
  using (public.is_own_bill_person(person_id) or public.is_bill_payer(bill_id));

-- Reject claim changes when the bill is closed or the item has any payment (SPEC 8.2
-- "Triggers"). Also guards against a spoofed `bill_id` that doesn't match `item_id`/`person_id`'s
-- real bill - `bill_id` is denormalized onto this table for the realtime filter (SPEC 8.3) and is
-- otherwise just another client-writable column, so the policies above can't trust it on their
-- own.
create function public.guard_claim_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid := coalesce(new.item_id, old.item_id);
  v_bill_id uuid := coalesce(new.bill_id, old.bill_id);
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if not exists (
      select 1 from public.bill_items bi where bi.id = new.item_id and bi.bill_id = new.bill_id
    ) then
      raise exception 'claims.bill_id does not match the item''s bill';
    end if;
    if not exists (
      select 1 from public.bill_people bp where bp.id = new.person_id and bp.bill_id = new.bill_id
    ) then
      raise exception 'claims.bill_id does not match the person''s bill';
    end if;
    if not exists (
      select 1 from public.bill_people bp where bp.id = new.created_by and bp.bill_id = new.bill_id
    ) then
      raise exception 'claims.created_by does not belong to this bill';
    end if;
    -- `created_by` records who actually made the claim; the RLS policy already restricts who can
    -- write a *claim* (person_id) to the caller themselves or the payer, but without this check a
    -- non-payer member could claim for themselves while setting created_by to any other
    -- bill_people id on the bill, misattributing the claim.
    if not (
      exists (
        select 1 from public.bill_people bp
        where bp.id = new.created_by and bp.user_id = auth.uid()
      )
      or public.is_bill_payer(new.bill_id)
    ) then
      raise exception 'claims.created_by must be the caller''s own bill_people row, or the payer''s';
    end if;
  end if;

  if public.is_item_locked(v_item_id, v_bill_id) then
    raise exception 'claims locked: bill % is closed or item % has a paid portion', v_bill_id, v_item_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger claims_lock_guard
  before insert or update or delete on public.claims
  for each row execute function public.guard_claim_change();

-- --- assignments ---------------------------------------------------------------------------------

create policy "assignments_select_members" on public.assignments
  for select
  using (public.is_bill_member(bill_id));

create policy "assignments_insert_payer" on public.assignments
  for insert
  with check (public.is_bill_payer(bill_id));

create policy "assignments_update_payer" on public.assignments
  for update
  using (public.is_bill_payer(bill_id))
  with check (public.is_bill_payer(bill_id));

create policy "assignments_delete_payer" on public.assignments
  for delete
  using (public.is_bill_payer(bill_id));

-- Same two rules as claims (closed bill, or the item already has a payment), plus the same
-- `bill_id`/membership spoofing guard, this time over the `assigned_to` array.
create function public.guard_assignment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid := coalesce(new.item_id, old.item_id);
  v_bill_id uuid := coalesce(new.bill_id, old.bill_id);
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if not exists (
      select 1 from public.bill_items bi where bi.id = new.item_id and bi.bill_id = new.bill_id
    ) then
      raise exception 'assignments.bill_id does not match the item''s bill';
    end if;
    if exists (
      select 1
      from unnest(new.assigned_to) as assignee_id
      where not exists (
        select 1 from public.bill_people bp
        where bp.id = assignee_id and bp.bill_id = new.bill_id
      )
    ) then
      raise exception 'assignments.assigned_to contains a person not on this bill';
    end if;
  end if;

  if public.is_item_locked(v_item_id, v_bill_id) then
    raise exception 'assignments locked: bill % is closed or item % has a paid portion', v_bill_id, v_item_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger assignments_lock_guard
  before insert or update or delete on public.assignments
  for each row execute function public.guard_assignment_change();

-- --- payments --------------------------------------------------------------------------------------

create policy "payments_select_members" on public.payments
  for select
  using (public.is_bill_member(bill_id));

create policy "payments_insert_payer" on public.payments
  for insert
  with check (public.is_bill_payer(bill_id));

create policy "payments_update_payer" on public.payments
  for update
  using (public.is_bill_payer(bill_id))
  with check (public.is_bill_payer(bill_id));

create policy "payments_delete_payer" on public.payments
  for delete
  using (public.is_bill_payer(bill_id));

-- No closed-bill or lock trigger here: FR-25 explicitly allows payment changes on closed bills,
-- and payments are what the item/claim/assignment locks key off of. Still guard the same
-- `bill_id` spoofing risk as claims/assignments.
create function public.guard_payment_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.bill_items bi where bi.id = new.item_id and bi.bill_id = new.bill_id
  ) then
    raise exception 'payments.bill_id does not match the item''s bill';
  end if;
  if not exists (
    select 1 from public.bill_people bp where bp.id = new.person_id and bp.bill_id = new.bill_id
  ) then
    raise exception 'payments.bill_id does not match the person''s bill';
  end if;
  return new;
end;
$$;

create trigger payments_consistency_guard
  before insert or update on public.payments
  for each row execute function public.guard_payment_consistency();

-- --- join_bill -----------------------------------------------------------------------------------

-- SPEC 8.2 "Joining": adds the caller (signed in or anonymous) as a member or guest, or returns
-- their existing row. `security definer` because the caller has no `bill_people` row yet, so
-- without it `bill_people_insert_named_by_payer` (the only insert policy) would always reject
-- them. The payer never needs this: `handle_new_bill` already gave them a `bill_people` row.
create function public.join_bill(p_share_token text, p_display_name text)
returns public.bill_people
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_uid uuid := auth.uid();
  v_kind text;
  v_name text := trim(coalesce(p_display_name, ''));
  v_person public.bill_people;
begin
  if v_uid is null then
    raise exception 'join_bill requires a session (signed in or anonymous)';
  end if;

  select * into v_bill from public.bills where share_token = p_share_token;
  if v_bill.id is null then
    raise exception 'no bill found for that share link';
  end if;

  if v_bill.status = 'closed' then
    raise exception 'this bill is closed';
  end if;

  if length(v_name) < 1 or length(v_name) > 30 then
    raise exception 'display_name must be 1 to 30 characters';
  end if;

  v_kind := case
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then 'guest'
    else 'member'
  end;

  insert into public.bill_people (bill_id, user_id, display_name, kind)
  values (v_bill.id, v_uid, v_name, v_kind)
  on conflict (bill_id, user_id) do nothing
  returning * into v_person;

  if v_person.id is null then
    select * into v_person from public.bill_people where bill_id = v_bill.id and user_id = v_uid;
  end if;

  return v_person;
end;
$$;

-- --- search_usernames ----------------------------------------------------------------------------

-- SPEC 8.2 "Username search": id/username/display_name only, >= 2 characters, at most 10 rows.
-- Unrelated to bills - grouped here because the spec groups it in 8.2 - and unused until a later
-- task wires it into the payer's "add by username" UI. Requires a session (signed in or
-- anonymous), same guard as `join_bill`: without it, `security definer` means even the public
-- `anon` key with no session at all could call this and scrape every username/display_name two
-- characters at a time. The prefix's own `%`/`_` are escaped so caller input is matched
-- literally instead of being interpreted as LIKE wildcards.
create function public.search_usernames(p_prefix text)
returns table (id uuid, username text, display_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'search_usernames requires a session (signed in or anonymous)';
  end if;

  -- Escape the caller's own backslashes first - otherwise a prefix containing one (e.g. `a\%`)
  -- would have its backslash interact with the `%`/`_` escaping below instead of being matched
  -- literally itself, leaving a wildcard unescaped.
  return query
    select p.id, p.username, p.display_name
    from public.profiles p
    where length(trim(p_prefix)) >= 2
      and p.username is not null
      and p.username ilike
        replace(replace(replace(trim(p_prefix), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    order by p.username
    limit 10;
end;
$$;
