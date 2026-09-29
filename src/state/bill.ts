/**
 * The bill zustand store: reactive state for screens, backed by the local
 * data-layer store (src/data/localBillStore.ts) and computed with src/lib
 * (resolveClaims -> calculateSplit, SPEC 6.2/6.1). No math happens here.
 */
import { create } from 'zustand';
import { createLocalBillStore, type StoredBill } from '../data/localBillStore';
import { getReceiptReader, type ImageCapture } from '../data/receiptReader';
import { resolveClaims, type ClaimMode, type ResolvedItem } from '../lib/claims/resolve';
import { calculateSplit, type Fee, type Person, type SplitResult, type Tip } from '../lib/split/split';
import type { TipSource } from '../lib/receipt/schema';
import { analytics } from './analytics';

const dataStore = createLocalBillStore();

export type BillState = {
  bills: Record<string, StoredBill>;

  createDraftBill: (payer: { id: string; name: string }) => string;
  startScan: (billId: string, image: ImageCapture) => Promise<void>;
  startManualEntry: (billId: string) => void;

  addItem: (billId: string, item: { name: string; priceCents: number }) => void;
  updateItem: (billId: string, itemId: string, patch: Partial<{ name: string; priceCents: number }>) => void;
  removeItem: (billId: string, itemId: string) => void;
  mergeItems: (billId: string, itemIds: string[]) => void;

  setDiscount: (billId: string, cents: number) => void;
  setTax: (billId: string, cents: number) => void;
  addFee: (billId: string, fee: { label: string; cents: number; split: Fee['split'] }) => void;
  setFeeSplit: (billId: string, feeId: string, split: Fee['split']) => void;
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

  return {
    bills: {},

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
            refresh(billId);
            analytics.record('parse_done', { itemCount: event.receipt.items.length });
          }
        }
      } catch {
        dataStore.failScan(billId, 'UPSTREAM_ERROR');
        refresh(billId);
      }
    },

    startManualEntry: (billId) => {
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
      refresh(billId);
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
    setFeeSplit: (billId, feeId, split) => {
      dataStore.updateFee(billId, feeId, { split });
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
