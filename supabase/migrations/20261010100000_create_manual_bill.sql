-- SPEC.md 8.1/8.2, M4 realtime-store task: manual entry (no scan) has no Edge Function in its
-- path, so it needs some other way to get a real `bills` row to attach to. `bills` deliberately
-- has no INSERT policy for a normal signed-in user ("Creating a bill stays service-role only",
-- the comment on `bills_update_payer` in the previous migration) - the only path that existed
-- before this one was the service-role `parse-receipt` function.
--
-- Same pattern as `register_push_token`/`increment_scan_usage`: `security definer` so the insert
-- bypasses `bills`' policy-free INSERT (there is none to bypass - it's simply absent), but the
-- function re-validates `auth.uid()` itself rather than trusting a caller-supplied id, so a normal
-- client still can't create a bill "for" anyone else, and still can't create one with an arbitrary
-- `payer_user_id`, `share_token`, or `status`. `handle_new_bill` (previous migration) still fires
-- on this INSERT exactly as it does for parse-receipt's, so the payer gets their own `bill_people`
-- row either way.
create function public.create_manual_bill()
returns public.bills
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bill public.bills;
begin
  if v_uid is null then
    raise exception 'create_manual_bill requires a signed-in session';
  end if;
  -- Same restriction as parse-receipt (handler.ts: `!user || user.isAnonymous`): only a real,
  -- non-anonymous account pays for and owns a bill. Guests only ever join one via `join_bill`.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'create_manual_bill requires a non-anonymous session';
  end if;

  insert into public.bills (payer_user_id)
  values (v_uid)
  returning * into v_bill;

  return v_bill;
end;
$$;

revoke all on function public.create_manual_bill() from public;
grant execute on function public.create_manual_bill() to authenticated;
