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
--
-- Idempotent the same way `join_bill` is (returns the existing row rather than erroring) rather
-- than raising on a duplicate invite: the payer searching and tapping the same person twice (e.g.
-- after a slow network response made the first tap look like it didn't register) is a normal,
-- expected case, not an error.
--
-- Sending an actual push notification about the invite is out of scope here - that's the `notify`
-- function (SPEC 8.7), a separate, later task that reads this row once it exists.
create function public.invite_bill_member(p_bill_id uuid, p_user_id uuid)
returns public.bill_people
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_person public.bill_people;
begin
  select * into v_bill from public.bills where id = p_bill_id;
  if v_bill.id is null then
    raise exception 'no bill found for id %', p_bill_id;
  end if;

  if v_bill.payer_user_id is distinct from auth.uid() then
    raise exception 'invite_bill_member: only the bill''s payer may invite a member';
  end if;

  -- SPEC 8.5: closed bills are read-only, same as every other payer-only write
  -- (`bill_people_insert_named_by_payer` blocks this the same way for a 'named' row).
  if v_bill.status = 'closed' then
    raise exception 'invite_bill_member: bill % is closed', p_bill_id;
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'invite_bill_member: no profile found for user %', p_user_id;
  end if;

  -- A payer inviting themselves would just collide with their own 'payer' row on
  -- `unique (bill_id, user_id)` below; reject it explicitly for a clearer error instead.
  if p_user_id = auth.uid() then
    raise exception 'invite_bill_member: the payer cannot invite themselves';
  end if;

  insert into public.bill_people (bill_id, user_id, display_name, kind)
  select
    v_bill.id,
    p_user_id,
    coalesce(p.display_name, p.username, 'Invited member'),
    'member'
  from public.profiles p
  where p.id = p_user_id
  on conflict (bill_id, user_id) do nothing
  returning * into v_person;

  if v_person.id is null then
    select * into v_person from public.bill_people where bill_id = v_bill.id and user_id = p_user_id;
  end if;

  return v_person;
end;
$$;

revoke all on function public.invite_bill_member(uuid, uuid) from public;
grant execute on function public.invite_bill_member(uuid, uuid) to authenticated;
