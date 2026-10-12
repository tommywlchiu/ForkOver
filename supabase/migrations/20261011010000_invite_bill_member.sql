-- SPEC.md 8.2/8.7, M4 in-app-sending task: the payer inviting a *specific, known* user (found via
-- the already-merged `search_usernames`) as a real bill member. `join_bill` only lets a caller add
-- *themselves* (`auth.uid()`-gated), so it can't be reused here; and the payer-insertable 'named'
-- row type is deliberately constrained (`bill_people_named_has_no_user`, previous migration) to
-- never carry a real `user_id`, specifically so a payer can never silently grant someone access
-- without their own consent. Inviting someone the payer explicitly chose from a search is a
-- different, legitimate case, but it still needs its own access rule, not a loophole in either of
-- those - this RPC is that rule.
--
-- Same pattern as `register_push_token`/`increment_scan_usage`/`create_manual_bill`: `security
-- definer` so the insert bypasses `bill_people`'s policies (there is no policy that would ever let
-- a payer insert a `kind = 'member'` row with someone else's `user_id` - only 'named' rows are
-- payer-insertable at all), but the function re-validates `auth.uid()` itself, rather than trusting
-- a caller-supplied payer id, so a non-payer still can't call this for a bill they don't own.
-- Reuses the same `is_bill_payer`/`is_bill_closed` helpers every other policy and trigger already
-- shares (`shared_bills_rls.sql`), rather than re-deriving the same checks by hand (code review).
--
-- Returns a row plus `already_member`: true if the invited user already had a `bill_people` row
-- on this bill (a repeat invite, or they'd already joined themselves as a member/guest via the
-- share link) - the caller can tell a payer "already on this bill" instead of a false "Invited"
-- when nothing actually changed (code review). This only catches a pre-existing row keyed by the
-- same real `user_id`; it deliberately does *not* attempt to merge into an existing `kind =
-- 'named'` placeholder for the same real person (a `'named'` row never carries a `user_id`, so
-- there's nothing to match it by) - that's the same identity-merge gap `join_bill`'s own migration
-- already calls out and leaves unsolved, not something this RPC introduces.
--
-- Sending an actual push notification about a successful invite is out of scope here - that's
-- the `notify` function (SPEC 8.7), a separate, later task that reads this row once it exists.
create function public.invite_bill_member(p_bill_id uuid, p_user_id uuid)
returns table (
  id uuid,
  bill_id uuid,
  user_id uuid,
  display_name text,
  kind text,
  joined_at timestamptz,
  already_member boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_existing public.bill_people;
  v_person public.bill_people;
begin
  if not exists (select 1 from public.bills b where b.id = p_bill_id) then
    raise exception 'no bill found for id %', p_bill_id;
  end if;

  if not public.is_bill_payer(p_bill_id) then
    raise exception 'invite_bill_member: only the bill''s payer may invite a member';
  end if;

  -- SPEC 8.5: closed bills are read-only, same as every other payer-only write
  -- (`bill_people_insert_named_by_payer` blocks this the same way for a 'named' row).
  if public.is_bill_closed(p_bill_id) then
    raise exception 'invite_bill_member: bill % is closed', p_bill_id;
  end if;

  -- A payer inviting themselves would just collide with their own 'payer' row on
  -- `unique (bill_id, user_id)` below; reject it explicitly for a clearer error instead.
  if p_user_id = auth.uid() then
    raise exception 'invite_bill_member: the payer cannot invite themselves';
  end if;

  -- One profiles lookup, reused for both the existence guard and the insert's own display name
  -- (code review) - `join_bill` doesn't need this because it takes `display_name` as a
  -- parameter instead.
  select * into v_profile from public.profiles p where p.id = p_user_id;
  if v_profile.id is null then
    raise exception 'invite_bill_member: no profile found for user %', p_user_id;
  end if;

  -- `join_bill`'s own safe shape, not a plain check-then-insert (code review): two concurrent
  -- invites of the same person (two devices, a retry racing the first attempt, or an invite
  -- racing that person's own `join_bill` call) would otherwise both pass a "not already a
  -- member" check and then race each other into `bill_people`'s `unique (bill_id, user_id)`,
  -- with the loser raising a raw `unique_violation` instead of returning `already_member: true`.
  -- `on conflict ... do nothing` makes the insert itself the atomic check. Targets the unique
  -- constraint by name (`bill_people_bill_id_user_id_key`), not an inline `(bill_id, user_id)`
  -- column list: this function's own `returns table` columns are named `bill_id`/`user_id` too,
  -- which plpgsql resolves as those OUT variables instead of the inserted row's columns, making
  -- an inline list ambiguous.
  insert into public.bill_people (bill_id, user_id, display_name, kind)
  values (p_bill_id, p_user_id, coalesce(v_profile.display_name, v_profile.username, 'Invited member'), 'member')
  on conflict on constraint bill_people_bill_id_user_id_key do nothing
  returning * into v_person;

  if v_person.id is not null then
    return query select
      v_person.id, v_person.bill_id, v_person.user_id, v_person.display_name,
      v_person.kind, v_person.joined_at, false;
    return;
  end if;

  -- The insert hit the conflict (already a member, by this call or a concurrent one) - report
  -- the existing row as `already_member: true` rather than erroring.
  select * into v_existing from public.bill_people bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  return query select
    v_existing.id, v_existing.bill_id, v_existing.user_id, v_existing.display_name,
    v_existing.kind, v_existing.joined_at, true;
end;
$$;

revoke all on function public.invite_bill_member(uuid, uuid) from public;
grant execute on function public.invite_bill_member(uuid, uuid) to authenticated;
