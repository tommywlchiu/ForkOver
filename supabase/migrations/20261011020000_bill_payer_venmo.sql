-- SPEC.md 2.3 step 4 / 6.6: the public claim page's "Pay on Venmo" button needs the payer's
-- Venmo username, but `profiles` only lets a user read their own row (`profiles_select_own`,
-- create_profiles migration) - a claimant can't select the payer's profile directly. This is a
-- narrow, single-purpose `security definer` RPC (same shape as `join_bill`/`search_usernames` in
-- the previous migration) rather than a broader "bill members can read each other's profiles"
-- policy, so it exposes only the one column the claim page actually needs.
create function public.get_bill_payer_venmo(p_bill_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_venmo text;
begin
  if not public.is_bill_member(p_bill_id) then
    return null;
  end if;

  select p.venmo_username into v_venmo
  from public.bills b
  join public.profiles p on p.id = b.payer_user_id
  where b.id = p_bill_id;

  return v_venmo;
end;
$$;
