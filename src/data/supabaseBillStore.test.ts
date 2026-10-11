/**
 * Unit coverage for `createSupabaseBillStore` (SPEC.md section 8, M4) that the screen-level
 * integration tests don't exercise directly: promotion itself (both paths - adopting a scan's
 * server id, and minting one through `create_manual_bill`), and that a promoted bill's edits
 * write through to the fake Supabase tables (see `src/data/__mocks__/supabaseClient.ts`) while an
 * unpromoted one stays local-only, same as `createLocalBillStore` always did.
 */
import { supabase } from './supabaseClient';
import { createSupabaseBillStore } from './supabaseBillStore';

jest.mock('./supabaseClient');
const { __resetFakeSupabase } = jest.requireMock('./supabaseClient') as { __resetFakeSupabase: () => void };

async function signIn(): Promise<string> {
  const { data } = await supabase.auth.setSession({ access_token: 'tok', refresh_token: 'tok' });
  return data.session!.user.id;
}

describe('createSupabaseBillStore', () => {
  beforeEach(() => {
    __resetFakeSupabase();
  });

  it('never touches the network for a bill that is never promoted', async () => {
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: 'local-payer', name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Nachos', priceCents: 900 });
    store.setClaim(bill.id, item.id, 'local-payer', 'mine', 'local-payer');

    expect(store.getBill(bill.id)!.items).toHaveLength(1);
    expect(store.getBill(bill.id)!.claims).toEqual([{ itemId: item.id, personId: 'local-payer', mode: 'mine', createdBy: 'local-payer' }]);
    // Nothing was ever written: the fake bills table (which would throw on an unhandled table,
    // and otherwise starts empty) has no rows for an id that only ever lived locally.
    const { data } = await supabase.from('bills').select('id').eq('id', bill.id);
    expect(data).toEqual([]);
  });

  it('promotes manual entry through create_manual_bill, flushing buffered items and fees', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    store.addItem(bill.id, { name: 'Nachos', priceCents: 900 });
    store.addFee(bill.id, { label: 'Service', cents: 100, split: 'proportional' });

    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });

    expect(promoted.id).not.toBe(bill.id);
    expect(store.getBill(bill.id)).toBeUndefined();
    expect(store.getBill(promoted.id)).toBe(promoted);
    // The payer's id is now the real bill_people row, not the raw user id (claims reference
    // bill_people, not auth users - SPEC 8.1).
    expect(promoted.payerId).not.toBe(userId);

    const { data: billRow } = await supabase.from('bills').select('id,payer_user_id').eq('id', promoted.id).maybeSingle();
    expect(billRow).toMatchObject({ payer_user_id: userId });

    const { data: items } = await supabase.from('bill_items').select('name,price_cents').eq('bill_id', promoted.id);
    expect(items).toEqual([{ id: promoted.items[0].id, bill_id: promoted.id, name: 'Nachos', price_cents: 900, position: 0 }]);

    const { data: fees } = await supabase.from('bill_fees').select('label,cents').eq('bill_id', promoted.id);
    expect(fees).toEqual([{ id: promoted.fees[0].id, bill_id: promoted.id, label: 'Service', cents: 100, split: 'proportional' }]);
  });

  it('promotes a scan by adopting the id parse-receipt already issued, with no RPC call', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const rpcSpy = jest.spyOn(supabase, 'rpc');

    // parse-receipt (service role) already created this row server-side before the scan's `done`
    // event ever names it (SPEC 7.1) - seed it the same way, including the payer `bill_people`
    // row `handle_new_bill`'s trigger would give it, so the real `fetchSnapshot` read-back
    // `promoteBill` does at the end can actually find it.
    await supabase.from('bills').insert({ id: 'server-bill-1', payer_user_id: userId, status: 'draft' });
    await supabase.from('bill_people').insert({ bill_id: 'server-bill-1', user_id: userId, display_name: 'Alex', kind: 'payer' });

    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' }, 'server-bill-1');

    expect(promoted.id).toBe('server-bill-1');
    expect(rpcSpy).not.toHaveBeenCalled();
    rpcSpy.mockRestore();
  });

  it('writes through to Supabase after promotion, and rolls back the local change on failure', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });

    store.setDiscount(promoted.id, 250);
    // The fire-and-forget write needs a tick to land.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getBill(promoted.id)!.discountCents).toBe(250);
    const { data: row } = await supabase.from('bills').select('discount_cents').eq('id', promoted.id).maybeSingle();
    expect(row).toMatchObject({ discount_cents: 250 });

    // A write that fails (e.g. an RLS rejection in production) reverts the optimistic change
    // rather than leaving it sitting in the local cache, and reports a short error (SPEC 8.3).
    const onSyncError = jest.fn();
    const storeWithErrors = createSupabaseBillStore(onSyncError);
    const draft = storeWithErrors.createDraftBill({ id: userId, name: 'Alex' });
    const otherPromoted = await storeWithErrors.promoteBill(draft.id, { id: userId, name: 'Alex' });

    const fromSpy = jest.spyOn(supabase, 'from').mockReturnValueOnce({
      insert: () => ({
        then: (onFulfilled: (r: { error: { message: string } }) => void) => Promise.resolve(onFulfilled({ error: { message: 'conflict' } })),
      }),
    } as unknown as ReturnType<typeof supabase.from>);

    storeWithErrors.addItem(otherPromoted.id, { name: 'Soda', priceCents: 300 });
    await Promise.resolve();
    await Promise.resolve();
    expect(storeWithErrors.getBill(otherPromoted.id)!.items).toEqual([]);
    expect(onSyncError).toHaveBeenCalledWith(otherPromoted.id, expect.stringContaining('add'));
    fromSpy.mockRestore();
  });

  // Code review on PR #31: promoteBill used to never flush claims at all, and silently marked a
  // bill "promoted" even when one of its writes failed - losing whatever didn't save on the very
  // next refetch, with nothing ever telling the payer.
  it('flushes claims made before promotion, not just items and fees', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Ramen', priceCents: 1200 });
    store.setClaim(bill.id, item.id, userId, 'mine', userId);

    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });

    expect(promoted.claims).toEqual([{ itemId: item.id, personId: promoted.payerId, mode: 'mine', createdBy: promoted.payerId }]);
    const { data: claimRows } = await supabase.from('claims').select('item_id,mode').eq('bill_id', promoted.id);
    expect(claimRows).toEqual([expect.objectContaining({ item_id: item.id, mode: 'mine' })]);
  });

  it('leaves a bill local-only (not promoted) when the flush fails, and lets a retry succeed', async () => {
    const userId = await signIn();
    const onSyncError = jest.fn();
    const store = createSupabaseBillStore(onSyncError);
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    store.addItem(bill.id, { name: 'Ramen', priceCents: 1200 });

    // The items upsert (one of the parallel writes) fails this one time; everything else on
    // `bill_items` (including `fetchSnapshot`'s own `select`, right after) still delegates to the
    // real fake table, as does every other table.
    const realFrom = supabase.from.bind(supabase);
    const fromSpy = jest.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const real = realFrom(table);
      if (table !== 'bill_items') return real;
      return {
        ...real,
        upsert: () => ({ then: (cb: (r: { error: { message: string } }) => void) => Promise.resolve(cb({ error: { message: 'conflict' } })) }),
      } as unknown as ReturnType<typeof supabase.from>;
    });

    const failed = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });

    expect(failed.id).toBe(bill.id); // unchanged: still the local draft, not rekeyed
    expect(store.getBill(bill.id)).toBe(failed);
    expect(onSyncError).toHaveBeenCalledWith(bill.id, expect.stringContaining('Try again'));
    fromSpy.mockRestore();

    // A retry (no spy interference this time) succeeds, reusing the id the first attempt already
    // minted - `create_manual_bill` is never called again for the same local draft, so a flaky
    // retry can't mint a second, orphaned bill.
    const rpcSpy = jest.spyOn(supabase, 'rpc');
    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });
    expect(promoted.id).not.toBe(bill.id);
    expect(promoted.items).toHaveLength(1);
    expect(rpcSpy).not.toHaveBeenCalled();
    rpcSpy.mockRestore();
  });

  it('mergeItems forces a reconciling refetch if the delete of the original items fails', async () => {
    const userId = await signIn();
    const onSyncError = jest.fn();
    const store = createSupabaseBillStore(onSyncError);
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id, { id: userId, name: 'Alex' });
    const a = store.addItem(promoted.id, { name: 'Beer', priceCents: 500 });
    const b = store.addItem(promoted.id, { name: 'Beer', priceCents: 500 });
    await Promise.resolve();
    await Promise.resolve();

    // Everything but the delete behaves normally (delegated to the real fake table); only the
    // `bill_items` delete this merge issues fails, simulating the insert succeeding but the
    // cleanup delete not (code review on #31: the local cache must not just show the merge while
    // the server keeps the stale originals around too).
    const realFrom = supabase.from.bind(supabase);
    const fromSpy = jest.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const real = realFrom(table);
      if (table !== 'bill_items') return real;
      return {
        ...real,
        delete: () => ({ in: () => Promise.resolve({ error: { message: 'conflict' } }) }),
      } as unknown as ReturnType<typeof supabase.from>;
    });

    store.mergeItems(promoted.id, [a.id, b.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSyncError).toHaveBeenCalledWith(promoted.id, expect.stringContaining('merging'));
    fromSpy.mockRestore();

    // The reconciling refetch picked up the server's actual (duplicated) state: the merged item
    // plus both stale originals the failed delete left behind.
    expect(store.getBill(promoted.id)!.items.map((i) => i.name).sort()).toEqual(['Beer', 'Beer', 'Beer']);
  });
});
