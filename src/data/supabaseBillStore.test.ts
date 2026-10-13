/**
 * Unit coverage for `createSupabaseBillStore` (SPEC.md section 8, M4) that the screen-level
 * integration tests don't exercise directly: promotion itself (both paths - adopting a scan's
 * server id, and minting one through `create_manual_bill`), and that a promoted bill's edits
 * write through to the fake Supabase tables (see `src/data/__mocks__/supabaseClient.ts`) while an
 * unpromoted one stays local-only, same as `createLocalBillStore` always did.
 */
import { supabase } from './supabaseClient';
import { createDebouncedLatestFetcher, createSupabaseBillStore, fetchBillByShareTokenIfMember, inviteBillMember } from './supabaseBillStore';

jest.mock('./supabaseClient');
const { __resetFakeSupabase, __seedProfile } = jest.requireMock('./supabaseClient') as {
  __resetFakeSupabase: () => void;
  __seedProfile: (id: string, profile: { username?: string | null; display_name?: string | null }) => void;
};

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

    const promoted = await store.promoteBill(bill.id);

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

    const promoted = await store.promoteBill(bill.id, 'server-bill-1');

    expect(promoted.id).toBe('server-bill-1');
    expect(rpcSpy).not.toHaveBeenCalled();
    rpcSpy.mockRestore();
  });

  it('writes through to Supabase after promotion, and rolls back the local change on failure', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);

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
    const otherPromoted = await storeWithErrors.promoteBill(draft.id);

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

    const promoted = await store.promoteBill(bill.id);

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

    const failed = await store.promoteBill(bill.id);

    expect(failed.id).toBe(bill.id); // unchanged: still the local draft, not rekeyed
    expect(store.getBill(bill.id)).toBe(failed);
    expect(onSyncError).toHaveBeenCalledWith(bill.id, expect.stringContaining('Try again'));
    fromSpy.mockRestore();

    // A retry (no spy interference this time) succeeds, reusing the id the first attempt already
    // minted - `create_manual_bill` is never called again for the same local draft, so a flaky
    // retry can't mint a second, orphaned bill.
    const rpcSpy = jest.spyOn(supabase, 'rpc');
    const promoted = await store.promoteBill(bill.id);
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
    const promoted = await store.promoteBill(bill.id);
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

  // The four tests below cover the concurrency bugs found in the second code-review round on
  // PR #31: an edit landing mid-promotion, two concurrent promotions, people never being flushed,
  // and a stale write's rollback clobbering a newer one.

  it('keeps an edit that lands on the local id while promotion is still in flight', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Ramen', priceCents: 1200 });

    const promotionPromise = store.promoteBill(bill.id);
    // Land an edit after promotion has started (past its RPC/people-lookup awaits) but before it
    // can possibly have finished its flush-and-confirm cycle.
    await Promise.resolve();
    await Promise.resolve();
    store.updateItem(bill.id, item.id, { name: 'Ramen (extra noodles)' });

    const promoted = await promotionPromise;

    expect(promoted.items.find((i) => i.id === item.id)?.name).toBe('Ramen (extra noodles)');
    const { data: row } = await supabase.from('bill_items').select('name').eq('id', item.id).maybeSingle();
    expect(row).toMatchObject({ name: 'Ramen (extra noodles)' });
  });

  it('a concurrent second promoteBill call never mints a second bill (double-tap Retry)', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });

    const rpcSpy = jest.spyOn(supabase, 'rpc');
    const [a, b] = await Promise.all([store.promoteBill(bill.id), store.promoteBill(bill.id)]);

    expect(a.id).toBe(b.id);
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    const { data: bills } = await supabase.from('bills').select('id').eq('payer_user_id', userId);
    expect(bills).toHaveLength(1);
    rpcSpy.mockRestore();
  });

  it('flushes named people too, so a claim referencing one does not hit a foreign-key violation', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Ramen', priceCents: 1200 });
    const bailey = store.addPerson(bill.id, 'Bailey');
    store.setClaim(bill.id, item.id, bailey.id, 'mine', userId);

    const promoted = await store.promoteBill(bill.id);

    expect(promoted.people.some((p) => p.name === 'Bailey')).toBe(true);
    const { data: peopleRows } = await supabase.from('bill_people').select('display_name').eq('bill_id', promoted.id);
    expect(peopleRows).toEqual(expect.arrayContaining([expect.objectContaining({ display_name: 'Bailey' })]));
    expect(promoted.claims).toEqual([{ itemId: item.id, personId: bailey.id, mode: 'mine', createdBy: promoted.payerId }]);
  });

  it('inviteBillMember adds a real member, is idempotent, and the invited row is readable by fetchSnapshot (what the realtime refetch reads)', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);

    __seedProfile('friend-1', { username: 'baileyb', display_name: 'Bailey' });

    const first = await inviteBillMember(promoted.id, 'friend-1');
    expect(first).toEqual({ error: null, alreadyMember: false });

    const { data: peopleRows } = await supabase.from('bill_people').select('user_id,display_name,kind').eq('bill_id', promoted.id);
    expect(peopleRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ user_id: 'friend-1', display_name: 'Bailey', kind: 'member' })]),
    );

    // Calling it again for the same user doesn't create a second row (matches join_bill's own
    // idempotent-return pattern, same as the pgTAP coverage for the real RPC), and is flagged
    // `alreadyMember` so the caller doesn't report a fresh invite when nothing changed.
    const second = await inviteBillMember(promoted.id, 'friend-1');
    expect(second).toEqual({ error: null, alreadyMember: true });
    const { data: afterSecondInvite } = await supabase.from('bill_people').select('id').eq('bill_id', promoted.id).eq('user_id', 'friend-1');
    expect(afterSecondInvite).toHaveLength(1);
  });

  it("does not let an older, now-stale write's failure revert a newer write to the same field", async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);

    let resolveFirst!: (v: { error: { message: string } | null }) => void;
    const firstWrite = new Promise<{ error: { message: string } | null }>((resolve) => {
      resolveFirst = resolve;
    });
    const realFrom = supabase.from.bind(supabase);
    let billsCallCount = 0;
    const fromSpy = jest.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table !== 'bills') return realFrom(table);
      billsCallCount += 1;
      if (billsCallCount === 1) return { update: () => ({ eq: () => firstWrite }) } as unknown as ReturnType<typeof supabase.from>;
      return realFrom(table);
    });

    store.setDiscount(promoted.id, 100); // slower write, will fail
    store.setDiscount(promoted.id, 200); // faster write to the same field, succeeds first
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getBill(promoted.id)!.discountCents).toBe(200);

    resolveFirst({ error: { message: 'stale conflict' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getBill(promoted.id)!.discountCents).toBe(200);
    fromSpy.mockRestore();
  });

  it('never reuses a bill_items position after a remove, even across a later add', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);

    store.addItem(promoted.id, { name: 'A', priceCents: 100 });
    const b = store.addItem(promoted.id, { name: 'B', priceCents: 200 });
    store.addItem(promoted.id, { name: 'C', priceCents: 300 });
    await Promise.resolve();
    await Promise.resolve();

    store.removeItem(promoted.id, b.id);
    await Promise.resolve();
    await Promise.resolve();

    store.addItem(promoted.id, { name: 'D', priceCents: 400 });
    await Promise.resolve();
    await Promise.resolve();

    const { data: rows } = await supabase.from('bill_items').select('name,position').eq('bill_id', promoted.id);
    const positions = (rows as { name: string; position: number }[]).map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  // Third round of code review on PR #31: dataStore's own cache and zustand kept two separate
  // copies of a bill, synced one direction only - a realtime update that only ever reached
  // zustand directly would get silently clobbered by the next local edit, which still read (and
  // mutated) the stale pre-update object dataStore's own cache never learned about.
  it('replaceBill makes a subsequent mutation build on the replaced state, not a stale earlier one', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);

    // Simulates a realtime update landing: something external (a second client's edit) added an
    // item server-side, and the snapshot comes back through `replaceBill` - exactly how
    // `src/state/bill.ts`'s `subscribeToBill`/`refetchBill` now apply a realtime snapshot.
    const remoteItem = { id: crypto.randomUUID(), name: 'Gyoza', priceCents: 600 };
    store.replaceBill({ ...promoted, items: [...promoted.items, remoteItem] });

    // A local edit right after must still see that remote item - if the mutator read from a
    // stale cache entry `replaceBill` never updated, this would silently drop it.
    const local = store.addItem(promoted.id, { name: 'Edamame', priceCents: 400 });

    const current = store.getBill(promoted.id)!;
    expect(current.items.map((i) => i.id).sort()).toEqual([remoteItem.id, local.id].sort());
  });

  it('redirects a mutator call against a bill\'s old local id to its promoted bill (a stale handler closure)', async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const localId = bill.id;
    const promoted = await store.promoteBill(localId);

    // A screen's event handler captured `localId` in a closure before promotion rekeyed the
    // cache (a narrow but real race - code review on #31). This must not throw.
    expect(() => store.addItem(localId, { name: 'Late item', priceCents: 100 })).not.toThrow();

    const current = store.getBill(promoted.id)!;
    expect(current.items.some((i) => i.name === 'Late item')).toBe(true);
  });

  it("mergeItems's revert on failure restores only what it removed, not a concurrent unrelated addItem", async () => {
    const userId = await signIn();
    const store = createSupabaseBillStore();
    const bill = store.createDraftBill({ id: userId, name: 'Alex' });
    const promoted = await store.promoteBill(bill.id);
    const a = store.addItem(promoted.id, { name: 'Beer', priceCents: 500 });
    const b = store.addItem(promoted.id, { name: 'Beer', priceCents: 500 });
    await Promise.resolve();
    await Promise.resolve();

    // The merge's insert fails; a concurrent, unrelated addItem is made while it's in flight.
    const realFrom = supabase.from.bind(supabase);
    let insertCalls = 0;
    const fromSpy = jest.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const real = realFrom(table);
      if (table !== 'bill_items') return real;
      return {
        ...real,
        insert: (payload: unknown) => {
          insertCalls += 1;
          // Only the merge's own insert (the first on this table after the mock is installed)
          // fails; a concurrent addItem's insert still succeeds via the real fake table.
          if (insertCalls === 1) return Promise.resolve({ error: { message: 'conflict' } });
          return real.insert(payload as never);
        },
      } as unknown as ReturnType<typeof supabase.from>;
    });

    store.mergeItems(promoted.id, [a.id, b.id]);
    const unrelated = store.addItem(promoted.id, { name: 'Soda', priceCents: 300 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fromSpy.mockRestore();

    const current = store.getBill(promoted.id)!;
    // The merge reverted to its two original items; the concurrent, unrelated addItem survived.
    expect(current.items.map((i) => i.name).sort()).toEqual(['Beer', 'Beer', 'Soda']);
    expect(current.items.some((i) => i.id === unrelated.id)).toBe(true);
  });
});

// Code review on PR #34: a transient read failure used to look identical to "not a member" (both
// collapsed to `null`), so the public claim link's caller would fall through to `join_bill`,
// which rejects a closed bill unconditionally - telling an actual member of a closed bill who hit
// a network blip "this bill is closed and you were never on it" instead of a retryable error.
describe('fetchBillByShareTokenIfMember', () => {
  it('returns not_member, not error, for a token with no RLS-visible row', async () => {
    await signIn();
    const result = await fetchBillByShareTokenIfMember('does-not-exist');
    expect(result).toEqual({ kind: 'not_member' });
  });

  it('returns error, not not_member, when the read itself fails', async () => {
    await signIn();
    const fromSpy = jest.spyOn(supabase, 'from').mockImplementationOnce(
      () =>
        ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'network blip' } }),
            }),
          }),
        }) as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await fetchBillByShareTokenIfMember('whatever-token');

    expect(result).toEqual({ kind: 'error' });
    fromSpy.mockRestore();
  });
});

describe('createDebouncedLatestFetcher', () => {
  it('applies only the most recently scheduled call, even if an earlier one resolves later', async () => {
    jest.useFakeTimers();
    try {
      const results: number[] = [];
      const resolvers: ((value: number) => void)[] = [];
      const fetchFn = jest.fn(() => new Promise<number>((resolve) => resolvers.push(resolve)));
      const { schedule } = createDebouncedLatestFetcher(fetchFn, (r) => results.push(r), 10);

      schedule();
      jest.advanceTimersByTime(10);
      schedule();
      jest.advanceTimersByTime(10);
      expect(resolvers).toHaveLength(2);

      // The later-scheduled request's fetch resolves first (plausible network jitter); the
      // earlier one resolves after.
      resolvers[1](200);
      await Promise.resolve();
      resolvers[0](100);
      await Promise.resolve();

      expect(results).toEqual([200]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('debounces several schedule() calls within the window into a single fetch', async () => {
    jest.useFakeTimers();
    try {
      const fetchFn = jest.fn(async () => 'ok');
      const { schedule } = createDebouncedLatestFetcher(fetchFn, () => {}, 10);

      schedule();
      schedule();
      schedule();
      jest.advanceTimersByTime(10);
      await Promise.resolve();

      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
