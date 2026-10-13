/**
 * The bill zustand store: reactive state for screens, backed by the local
 * data-layer store (src/data/localBillStore.ts) and computed with src/lib
 * (resolveClaims -> calculateSplit, SPEC 6.2/6.1). No math happens here.
 */
import { create } from 'zustand';
import type { StoredBill } from '../data/localBillStore';
import { getReceiptReader, type ImageCapture } from '../data/receiptReader';
import { createSupabaseBillStore, fetchBillSnapshot, inviteBillMember, subscribeToBillChanges } from '../data/supabaseBillStore';
import { resolveClaims, type ClaimMode, type ResolvedItem } from '../lib/claims/resolve';
import { calculateSplit, type Fee, type Person, type SplitResult, type Tip } from '../lib/split/split';
import type { TipSource } from '../lib/receipt/schema';
import { analytics } from './analytics';
import { useSessionStore } from './session';

const dataStore = createSupabaseBillStore((billId, message) => {
  useBillStore.setState((state) => ({ syncErrors: { ...state.syncErrors, [billId]: message } }));
});

export type BillState = {
  bills: Record<string, StoredBill>;
  /** Old (local, pre-promotion) bill id -> the real id it was promoted to (SPEC.md section 8, M4). */
  renamedBillIds: Record<string, string>;
  /** Last sync-failure message per bill, for a screen to show and dismiss (SPEC 8.3). */
  syncErrors: Record<string, string>;
  dismissSyncError: (billId: string) => void;
  /**
   * Bill ids whose promotion (local id -> real server id) was attempted and failed - a persistent
   * state, not a one-off toast like `syncErrors`, since every future edit on an unpromoted bill
   * stays local-only and never reaches the server until promotion succeeds (code review on #31).
   */
  unsyncedBillIds: Record<string, true>;
  /** Retries promotion for a bill still stuck local-only (SPEC 8.3; `unsyncedBillIds`). */
  retrySync: (billId: string) => Promise<void>;

  createDraftBill: (payer: { id: string; name: string }) => string;
  startScan: (billId: string, image: ImageCapture) => Promise<void>;
  /** Resolves to the real bill id once manual entry's draft bill exists server-side (SPEC 8, M4). */
  startManualEntry: (billId: string) => Promise<string>;
  /** Subscribes to realtime changes for this (real) bill id; call the returned function to unsubscribe. */
  subscribeToBill: (billId: string) => () => void;
  /** Refetches the full bill snapshot from Supabase (SPEC 8.3's reconnect behavior). */
  refetchBill: (billId: string) => Promise<void>;
  /**
   * Hydrates the store with a bill snapshot fetched some other way than the usual
   * draft-bill-then-promote flow (SPEC.md section 4, `b/[token]`) - the public claim route's own
   * `joinBillByToken`/`fetchBillByShareTokenIfMember` already return a full `StoredBill`, so this
   * is the one call that makes `useResolvedBill` (and everything built on it: offline gating,
   * realtime, the sync banners) work for that screen too, the same as every other bill screen.
   */
  loadBill: (bill: StoredBill) => void;

  addItem: (billId: string, item: { name: string; priceCents: number }) => void;
  updateItem: (billId: string, itemId: string, patch: Partial<{ name: string; priceCents: number }>) => void;
  removeItem: (billId: string, itemId: string) => void;
  mergeItems: (billId: string, itemIds: string[]) => void;

  setDiscount: (billId: string, cents: number) => void;
  setTax: (billId: string, cents: number) => void;
  addFee: (billId: string, fee: { label: string; cents: number; split: Fee['split'] }) => void;
  updateFee: (billId: string, feeId: string, patch: Partial<Pick<Fee, 'label' | 'cents' | 'split'>>) => void;
  removeFee: (billId: string, feeId: string) => void;
  setTip: (billId: string, tip: Tip, source: TipSource | null) => void;

  addPerson: (billId: string, name: string) => string;
  /**
   * Invites a specific user, found via username search, as a real bill member (SPEC.md 8.2, M4
   * in-app-sending task). Resolves to an error message on failure, or `null` on success - the
   * caller (the share screen) doesn't need the new `bill_people` row itself: it reaches this
   * store through the existing realtime subscription (`subscribeToBill`), the same path any other
   * screen's own change arrives through. `alreadyMember` is true when the invited user already
   * had a row on this bill - nothing new happened, so the caller shouldn't report a fresh invite.
   */
  invitePerson: (billId: string, userId: string) => Promise<{ error: string | null; alreadyMember: boolean }>;
  toggleMine: (billId: string, itemId: string, personId: string) => void;
  toggleShared: (billId: string, itemId: string, personId: string) => void;

  confirmReview: (billId: string) => void;
  markSent: (billId: string) => void;

  getSplit: (billId: string) => SplitResult | null;
  getResolvedItems: (billId: string) => ResolvedItem[];
  /** The raw claim mode this exact person currently has on this item ('none' if unclaimed by them). */
  claimFor: (billId: string, itemId: string, personId: string) => ClaimMode | 'none';
};

export const useBillStore = create<BillState>((set, get) => {
  function refresh(billId: string) {
    const bill = dataStore.getBill(billId);
    if (!bill) return;
    set((state) => ({ bills: { ...state.bills, [billId]: { ...bill } } }));
  }

  /**
   * Closes the local-id-vs-server-id gap (SPEC.md section 8, M4): flushes a local draft to its
   * real server-backed bill (minting one via `create_manual_bill` when `serverId` is omitted,
   * adopting the scan's own id otherwise - see `supabaseBillStore.ts`'s module doc) and rekeys
   * `bills`/`renamedBillIds` so a screen still mounted on the old (local) id keeps resolving to
   * the same bill, just under its real id from here on.
   *
   * `promoteBill` never partially succeeds: on any failure it returns the same draft, unchanged,
   * still under `localId` (see its own doc). That's the signal used below to tell success from
   * failure, rather than trusting a boolean the lower layer would have to remember to report
   * correctly too - `promoted.id === localId` is only ever true when nothing actually promoted.
   */
  async function promote(localId: string, serverId?: string): Promise<string> {
    const draft = get().bills[localId];
    if (!draft) return localId;
    // promoteBill resolves the real payer identity itself (a `bill_people` read server-side), not
    // from a caller-supplied value, so there's nothing to pass it here.
    const promoted = await dataStore.promoteBill(localId, serverId);

    if (promoted.id === localId) {
      // Promotion failed; the draft is untouched and still local-only. Flag it so a screen can
      // show a persistent "not synced" state instead of just the one-off `syncErrors` toast
      // `onSyncError` already set.
      set((state) => ({ bills: { ...state.bills, [localId]: promoted }, unsyncedBillIds: { ...state.unsyncedBillIds, [localId]: true } }));
      return localId;
    }

    set((state) => {
      const { [localId]: _removedBill, ...restBills } = state.bills;
      const { [localId]: _removedFlag, ...restUnsynced } = state.unsyncedBillIds;
      return {
        bills: { ...restBills, [promoted.id]: promoted },
        renamedBillIds: { ...state.renamedBillIds, [localId]: promoted.id },
        unsyncedBillIds: restUnsynced,
      };
    });
    return promoted.id;
  }

  return {
    bills: {},
    renamedBillIds: {},
    syncErrors: {},
    dismissSyncError: (billId) => {
      set((state) => {
        const { [billId]: _removed, ...rest } = state.syncErrors;
        return { syncErrors: rest };
      });
    },
    unsyncedBillIds: {},
    retrySync: async (billId) => {
      await promote(billId);
    },

    createDraftBill: (payer) => {
      const bill = dataStore.createDraftBill(payer);
      refresh(bill.id);
      return bill.id;
    },

    startScan: async (billId, image) => {
      analytics.record('scan_shutter');
      dataStore.beginScan(billId);
      refresh(billId);

      const reader = getReceiptReader();
      let firstItemSeen = false;
      try {
        for await (const event of reader(image)) {
          if (event.type === 'item') {
            dataStore.addStreamedLine(billId, event);
            refresh(billId);
            if (!firstItemSeen) {
              firstItemSeen = true;
              analytics.record('parse_first_item');
            }
          } else if (event.type === 'error') {
            dataStore.failScan(billId, event.code);
            refresh(billId);
            return;
          } else {
            dataStore.finalizeScan(billId, event.receipt);
            // Promote (and only then publish) before this scan's totals become visible: SPEC
            // 7.1's wire protocol only names the real bill id in this `done` event, so this is
            // the first moment a real id exists to sync up to (receiptReader.ts's `billId`).
            // Publishing `refresh` first would let a screen interact with the bill under its
            // stale local id while the promotion is still in flight. `event.billId` is only ever
            // absent from the stand-in reader (src/lib/receipt/standIn), which every jest test
            // drives instead of the network - the bill then just stays local-only, same as
            // createLocalBillStore always behaved, matching `ParseEvent.billId`'s doc on why it's
            // optional (receiptReader.ts).
            const finalBillId = event.billId ? await promote(billId, event.billId) : billId;
            refresh(finalBillId);
            analytics.record('parse_done', { itemCount: event.receipt.items.length });
            // Counts against the free-tier quota only on a successful scan (SPEC 7.1 step 5);
            // manual entry (startManualEntry) never reaches this branch, so it never counts.
            useSessionStore.getState().recordScanUsed();
          }
        }
      } catch {
        dataStore.failScan(billId, 'UPSTREAM_ERROR');
        refresh(billId);
      }
    },

    startManualEntry: async (billId) => {
      dataStore.finalizeScan(billId, {
        isReceipt: true,
        merchantName: null,
        currency: 'USD',
        rows: [],
        items: [],
        discountCents: 0,
        taxCents: 0,
        fees: [],
        printedTipCents: null,
        tipSource: null,
        printedSubtotalCents: null,
        printedTotalCents: null,
        warnings: [],
      });
      // Manual entry has no Edge Function in its path (SPEC.md section 8, M4): promote
      // immediately, minting the server-side draft bill through `create_manual_bill` (no scan
      // `done` event will ever supply an id here).
      const realId = await promote(billId);
      refresh(realId);
      return realId;
    },

    subscribeToBill: (billId) => {
      return subscribeToBillChanges(
        billId,
        (snapshot) => {
          if (!snapshot) return;
          // Write through `dataStore` first, not straight into zustand: every mutator
          // (addItem, setClaim, ...) reads its starting point from `dataStore`'s own cache via
          // `require(billId)`, not from zustand. A realtime update that only ever reached
          // zustand would get silently clobbered by the next local edit, which would still
          // mutate the stale pre-update object `dataStore` never learned about (code review on
          // #31). `refresh` is what then copies `dataStore`'s now-current state into zustand -
          // the same one-way flow every other method here already uses.
          dataStore.replaceBill(snapshot);
          refresh(billId);
        },
        // Read fresh on every refetch, not once when the subscription starts: `assemble()` falls
        // back to this for fields with no DB column (tipSource, warnings, scanState, ...), so a
        // stale closed-over snapshot would silently revert them to their mount-time values on
        // every later refetch (code review on #31).
        () => get().bills[billId],
      );
    },

    refetchBill: async (billId) => {
      const snapshot = await fetchBillSnapshot(billId, get().bills[billId]);
      if (!snapshot) return;
      dataStore.replaceBill(snapshot); // see subscribeToBill's comment: dataStore is the source of truth
      refresh(billId);
    },

    loadBill: (bill) => {
      dataStore.replaceBill(bill); // same one-way flow as subscribeToBill/refetchBill above
      refresh(bill.id);
    },

    invitePerson: async (billId, userId) => {
      return inviteBillMember(billId, userId);
    },

    addItem: (billId, item) => {
      dataStore.addItem(billId, item);
      refresh(billId);
    },
    updateItem: (billId, itemId, patch) => {
      dataStore.updateItem(billId, itemId, patch);
      refresh(billId);
    },
    removeItem: (billId, itemId) => {
      dataStore.removeItem(billId, itemId);
      refresh(billId);
    },
    mergeItems: (billId, itemIds) => {
      dataStore.mergeItems(billId, itemIds);
      refresh(billId);
    },

    setDiscount: (billId, cents) => {
      dataStore.setDiscount(billId, cents);
      refresh(billId);
    },
    setTax: (billId, cents) => {
      dataStore.setTax(billId, cents);
      refresh(billId);
    },
    addFee: (billId, fee) => {
      dataStore.addFee(billId, fee);
      refresh(billId);
    },
    updateFee: (billId, feeId, patch) => {
      dataStore.updateFee(billId, feeId, patch);
      refresh(billId);
    },
    removeFee: (billId, feeId) => {
      dataStore.removeFee(billId, feeId);
      refresh(billId);
    },
    setTip: (billId, tip, source) => {
      dataStore.setTip(billId, tip, source);
      refresh(billId);
    },

    addPerson: (billId, name) => {
      const person = dataStore.addPerson(billId, name);
      refresh(billId);
      return person.id;
    },

    toggleMine: (billId, itemId, personId) => {
      const bill = get().bills[billId];
      if (!bill) return;
      const existing = bill.claims.find((c) => c.itemId === itemId && c.personId === personId);
      // `created_by` is the person claiming for themselves here - both current callers (the payer
      // tapping their own bill screen, and `b/[token].tsx`'s guest/member tapping "Mine" for
      // themselves) always have `personId` acting for its own `bill_people` row. Hardcoding
      // `bill.payerId` here used to be a no-op for the payer's own taps (the only caller before
      // this screen existed) but silently broke every non-payer claim: `guard_claim_change` (the
      // DB trigger, SPEC 8.2) requires `created_by`'s `user_id` to match the caller's `auth.uid()`
      // or the caller to be the payer - a guest/member is neither, so the write was rejected
      // outright. "Claim for anyone" (FR-32, the payer claiming on another person's behalf) is
      // M5 and isn't built yet; it will need its own explicit path that passes the payer's id on
      // purpose, not this implicit default.
      if (existing?.mode === 'mine') dataStore.clearClaim(billId, itemId, personId);
      else dataStore.setClaim(billId, itemId, personId, 'mine', personId);
      refresh(billId);
    },
    toggleShared: (billId, itemId, personId) => {
      const bill = get().bills[billId];
      if (!bill) return;
      const existing = bill.claims.find((c) => c.itemId === itemId && c.personId === personId);
      // See toggleMine's comment just above - same fix, same reason.
      if (existing?.mode === 'shared') dataStore.clearClaim(billId, itemId, personId);
      else dataStore.setClaim(billId, itemId, personId, 'shared', personId);
      refresh(billId);
    },

    confirmReview: (billId) => {
      dataStore.openBill(billId);
      refresh(billId);
      analytics.record('review_confirmed');
    },
    markSent: (billId) => {
      dataStore.markSent(billId);
      refresh(billId);
      analytics.record('bill_sent');
    },

    getSplit: (billId) => {
      const bill = get().bills[billId];
      if (!bill) return null;
      const resolved = resolveClaims({
        itemIds: bill.items.map((item) => item.id),
        claims: bill.claims,
        assignments: [],
      });
      const resolvedMap = new Map(resolved.map((r) => [r.itemId, r]));
      const items = bill.items.map((item) => ({
        id: item.id,
        name: item.name,
        priceCents: item.priceCents,
        assignedTo: resolvedMap.get(item.id)?.assignedTo ?? [],
      }));
      const people: Person[] = bill.people.map((p) => ({ id: p.id, name: p.name }));
      return calculateSplit({
        payerId: bill.payerId,
        people,
        items,
        discountCents: bill.discountCents,
        taxCents: bill.taxCents,
        tip: bill.tip,
        fees: bill.fees,
      });
    },

    getResolvedItems: (billId) => {
      const bill = get().bills[billId];
      if (!bill) return [];
      return resolveClaims({
        itemIds: bill.items.map((item) => item.id),
        claims: bill.claims,
        assignments: [],
      });
    },

    claimFor: (billId, itemId, personId) => {
      const bill = get().bills[billId];
      if (!bill) return 'none';
      const claim = bill.claims.find((c) => c.itemId === itemId && c.personId === personId);
      return claim?.mode ?? 'none';
    },
  };
});
