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
});
