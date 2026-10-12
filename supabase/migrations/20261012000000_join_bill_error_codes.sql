-- `join_bill`'s client (src/app/b/[token].tsx, src/data/supabaseBillStore.ts's `joinBillByToken`)
-- used to tell its error cases apart by substring-matching the raw exception message ('no bill
-- found', 'is closed', '1 to 30 characters') - nothing tied that matching to this function's
-- actual text, so a future wording change here would silently fall through to a generic error
-- client-side instead of failing loudly. Re-creates `join_bill` unchanged except for a distinct
-- custom SQLSTATE per case (`FO` prefix, ForkOver-specific, chosen to avoid any built-in Postgres
-- code), which the client now switches on instead. Messages are left exactly as they were:
-- `supabase/tests/bill_people_rls.test.sql`'s `throws_ok` assertions (by message) still hold.
create or replace function public.join_bill(p_share_token text, p_display_name text)
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
    raise exception 'join_bill requires a session (signed in or anonymous)' using errcode = 'FO001';
  end if;

  select * into v_bill from public.bills where share_token = p_share_token;
  if v_bill.id is null then
    raise exception 'no bill found for that share link' using errcode = 'FO002';
  end if;

  if v_bill.status = 'closed' then
    raise exception 'this bill is closed' using errcode = 'FO003';
  end if;

  if length(v_name) < 1 or length(v_name) > 30 then
    raise exception 'display_name must be 1 to 30 characters' using errcode = 'FO004';
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
