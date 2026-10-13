-- SPEC.md 8.7, M4 notify task: `invite_bill_member` (previous migration's comment already pointed
-- here) is the real "payer sends them a bill in the app" event - it is the only call site that
-- ever inserts a `kind = 'member'` row on a payer's own initiative. `CREATE OR REPLACE` keeps the
-- function's signature, security, and every existing check identical; it only adds one insert
-- into `notification_events`, and only on the branch that actually created a fresh row (never on
-- the `already_member` branch below - a repeat invite or a self-join via the share link racing it
-- changed nothing, so there is nothing new to notify about).
create or replace function public.invite_bill_member(p_bill_id uuid, p_user_id uuid)
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

  if public.is_bill_closed(p_bill_id) then
    raise exception 'invite_bill_member: bill % is closed', p_bill_id;
  end if;

  if p_user_id = auth.uid() then
    raise exception 'invite_bill_member: the payer cannot invite themselves';
  end if;

  select * into v_profile from public.profiles p where p.id = p_user_id;
  if v_profile.id is null then
    raise exception 'invite_bill_member: no profile found for user %', p_user_id;
  end if;

  insert into public.bill_people (bill_id, user_id, display_name, kind)
  values (p_bill_id, p_user_id, coalesce(v_profile.display_name, v_profile.username, 'Invited member'), 'member')
  on conflict on constraint bill_people_bill_id_user_id_key do nothing
  returning * into v_person;

  if v_person.id is not null then
    -- A genuinely new member row - the one case SPEC 8.7 wants a push for. The webhook on
    -- `notification_events` (next migration) picks this up; a failure to queue it would be
    -- surprising enough to be worth surfacing rather than silently dropping the notification, so
    -- this is not wrapped in its own exception handler.
    insert into public.notification_events (event_type, bill_id, recipient_user_id)
    values ('bill_member_invited', p_bill_id, p_user_id);

    return query select
      v_person.id, v_person.bill_id, v_person.user_id, v_person.display_name,
      v_person.kind, v_person.joined_at, false;
    return;
  end if;

  select * into v_existing from public.bill_people bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  return query select
    v_existing.id, v_existing.bill_id, v_existing.user_id, v_existing.display_name,
    v_existing.kind, v_existing.joined_at, true;
end;
$$;

revoke all on function public.invite_bill_member(uuid, uuid) from public;
grant execute on function public.invite_bill_member(uuid, uuid) to authenticated;
