-- SPEC.md 8.3: "Clients subscribe to Postgres changes for one bill (bills, bill_people,
-- bill_items, bill_fees, claims, assignments, payments), filtered by bill_id." Supabase Realtime
-- only fans out changes for tables explicitly added to the `supabase_realtime` publication - by
-- default a fresh table is in no publication at all, so until this migration runs,
-- `subscribeToBillChanges` (src/data/supabaseBillStore.ts) is subscribed correctly but will never
-- actually receive an event, in any environment. `supabase_realtime` is created automatically by
-- every Supabase project (including this one's local stack), so this migration only needs to add
-- tables to it, not create it.
alter publication supabase_realtime add table
  public.bills,
  public.bill_people,
  public.bill_items,
  public.bill_fees,
  public.claims,
  public.assignments,
  public.payments;
