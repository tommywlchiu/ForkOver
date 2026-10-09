-- SPEC.md 8.1: an atomic upsert-and-increment for scan_usage, so concurrent scans from the same
-- user can't race past the monthly quota (SPEC 13 default 5) by both reading the same count
-- before either writes it back. Only `recordSuccessfulScan` (parse-receipt, service role) calls
-- this. `security invoker` means it carries no privilege of its own: even if `anon` or
-- `authenticated` called it directly, the insert inside still hits scan_usage's policy-free RLS
-- and is denied, exactly as if they'd written the table directly (see the pgTAP test).
create function public.increment_scan_usage(p_user_id uuid, p_period text)
returns integer
language sql
security invoker
as $$
  insert into public.scan_usage (user_id, period, count)
  values (p_user_id, p_period, 1)
  on conflict (user_id, period) do update set count = public.scan_usage.count + 1
  returning count;
$$;
