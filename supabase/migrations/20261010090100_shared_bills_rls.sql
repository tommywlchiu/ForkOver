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

-- --- bill_people --------------------------------------------------------------------------------

create policy "bill_people_select_members" on public.bill_people
  for select
  using (public.is_bill_member(bill_id));

-- Members and guests join through `join_bill` (security definer, below), which bypasses this
-- policy entirely. The only direct insert this table allows is the payer adding a named person
-- (SPEC 8.2 "Payer only").
create policy "bill_people_insert_named_by_payer" on public.bill_people
  for insert
  with check (kind = 'named' and public.is_bill_payer(bill_id));

create policy "bill_people_update_named_by_payer" on public.bill_people
  for update
  using (kind = 'named' and public.is_bill_payer(bill_id))
  with check (kind = 'named' and public.is_bill_payer(bill_id));

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

-- FR-17: an item with any paid portion is locked, even for the payer. The policy above still
-- lets the payer's UPDATE/DELETE statement through; this trigger is what actually enforces the
-- lock at the database layer regardless of who's asking.
create function public.guard_bill_item_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid := coalesce(new.id, old.id);
begin
  if exists (select 1 from public.payments p where p.item_id = v_item_id) then
    raise exception 'bill_items locked: item % has a paid portion', v_item_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger bill_items_lock_guard
  before update or delete on public.bill_items
  for each row execute function public.guard_bill_item_lock();

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
  end if;

  if exists (select 1 from public.bills b where b.id = v_bill_id and b.status = 'closed') then
    raise exception 'claims locked: bill % is closed', v_bill_id;
  end if;

  if exists (select 1 from public.payments p where p.item_id = v_item_id) then
    raise exception 'claims locked: item % has a paid portion', v_item_id;
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

  if exists (select 1 from public.bills b where b.id = v_bill_id and b.status = 'closed') then
    raise exception 'assignments locked: bill % is closed', v_bill_id;
  end if;

  if exists (select 1 from public.payments p where p.item_id = v_item_id) then
    raise exception 'assignments locked: item % has a paid portion', v_item_id;
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
-- task wires it into the payer's "add by username" UI.
create function public.search_usernames(p_prefix text)
returns table (id uuid, username text, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name
  from public.profiles p
  where length(trim(p_prefix)) >= 2
    and p.username is not null
    and p.username ilike trim(p_prefix) || '%'
  order by p.username
  limit 10;
$$;
