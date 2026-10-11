/**
 * The bill zustand store: reactive state for screens, backed by the local
 * data-layer store (src/data/localBillStore.ts) and computed with src/lib
 * (resolveClaims -> calculateSplit, SPEC 6.2/6.1). No math happens here.
 */
import { create } from 'zustand';
import type { StoredBill } from '../data/localBillStore';
import { getReceiptReader, type ImageCapture } from '../data/receiptReader';
import { createSupabaseBillStore, fetchBillSnapshot, subscribeToBillChanges } from '../data/supabaseBillStore';
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

  createDraftBill: (payer: { id: string; name: string }) => string;
  startScan: (billId: string, image: ImageCapture) => Promise<void>;
  /** Resolves to the real bill id once manual entry's draft bill exists server-side (SPEC 8, M4). */
  startManualEntry: (billId: string) => Promise<string>;
  /** Subscribes to realtime changes for this (real) bill id; call the returned function to unsubscribe. */
  subscribeToBill: (billId: string) => () => void;
  /** Refetches the full bill snapshot from Supabase (SPEC 8.3's reconnect behavior). */
  refetchBill: (billId: string) => Promise<void>;

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
   */
  async function promote(localId: string, serverId?: string): Promise<string> {
    const draft = get().bills[localId];
    if (!draft) return localId;
    const payerPerson = draft.people.find((p) => p.kind === 'payer') ?? draft.people[0];
    const promoted = await dataStore.promoteBill(localId, { id: draft.payerId, name: payerPerson?.name ?? '' }, serverId);
    set((state) => {
      const { [localId]: _removed, ...rest } = state.bills;
      return {
        bills: { ...rest, [promoted.id]: promoted },
        renamedBillIds: promoted.id === localId ? state.renamedBillIds : { ...state.renamedBillIds, [localId]: promoted.id },
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
      return subscribeToBillChanges(billId, (snapshot) => {
        if (!snapshot) return;
        set((state) => ({ bills: { ...state.bills, [billId]: snapshot } }));
      }, get().bills[billId]);
    },

    refetchBill: async (billId) => {
      const snapshot = await fetchBillSnapshot(billId, get().bills[billId]);
      if (snapshot) set((state) => ({ bills: { ...state.bills, [billId]: snapshot } }));
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
      if (existing?.mode === 'mine') dataStore.clearClaim(billId, itemId, personId);
      else dataStore.setClaim(billId, itemId, personId, 'mine', bill.payerId);
      refresh(billId);
    },
    toggleShared: (billId, itemId, personId) => {
      const bill = get().bills[billId];
      if (!bill) return;
      const existing = bill.claims.find((c) => c.itemId === itemId && c.personId === personId);
      if (existing?.mode === 'shared') dataStore.clearClaim(billId, itemId, personId);
      else dataStore.setClaim(billId, itemId, personId, 'shared', bill.payerId);
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
