/**
 * The bill store interface, and an in-memory implementation of it. This is
 * the seam SPEC.md section 11 (M3) asks for: screens and the zustand store
 * (src/state/bill.ts) only ever talk to `BillStore`, so swapping in the
 * Supabase-backed implementation later (M4) touches this file only, not the
 * screens. All math is delegated to src/lib; this file only stores state.
 */
import { allocate, type Fee, type Tip } from '../lib/split/split';
import type { Claim, ClaimMode } from '../lib/claims/resolve';
import type { ParsedLineItem, ParsedReceipt, TipSource } from '../lib/receipt/schema';

export type BillStatus = 'draft' | 'open' | 'closed';
// 'member' and 'guest' only ever appear once something writes a bill_people row of that kind -
// the join-bill flow (SPEC 8.2), out of scope for this task - but a promoted bill's realtime
// refetch (supabaseBillStore.ts `assemble`) already reads them back so the payer's bill screen
// shows a member/guest's claims live the moment that flow exists, rather than needing another
// change here later.
export type PersonKind = 'payer' | 'named' | 'member' | 'guest';
export type ScanState = 'idle' | 'streaming' | 'done' | 'error';

export type StoredPerson = { id: string; name: string; kind: PersonKind };
export type StoredItem = { id: string; name: string; priceCents: number };

export type StoredBill = {
  id: string;
  status: BillStatus;
  title: string;
  merchantName: string | null;
  currency: string;
  payerId: string;
  people: StoredPerson[];
  items: StoredItem[];
  discountCents: number;
  taxCents: number;
  tip: Tip;
  /** Where the tip came from; null once the payer picks a chip themselves. */
  tipSource: TipSource | null;
  fees: Fee[];
  claims: Claim[];
  warnings: string[];
  printedSubtotalCents: number | null;
  printedTotalCents: number | null;
  scanState: ScanState;
  scanError: string | null;
  createdAt: number;
  sentAt: number | null;
};

let nextId = 1;
/** Overridable so tests get deterministic ids; production uses the counter. */
export function makeLocalId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

export interface BillStore {
  createDraftBill(payer: { id: string; name: string }): StoredBill;
  getBill(billId: string): StoredBill | undefined;
  listBills(): StoredBill[];

  beginScan(billId: string): void;
  addStreamedLine(billId: string, line: ParsedLineItem): StoredItem[];
  finalizeScan(billId: string, receipt: ParsedReceipt): void;
  failScan(billId: string, code: string): void;

  addItem(billId: string, item: { name: string; priceCents: number }): StoredItem;
  updateItem(billId: string, itemId: string, patch: Partial<{ name: string; priceCents: number }>): void;
  removeItem(billId: string, itemId: string): void;
  mergeItems(billId: string, itemIds: string[]): void;

  setDiscount(billId: string, cents: number): void;
  setTax(billId: string, cents: number): void;
  addFee(billId: string, fee: { label: string; cents: number; split: Fee['split'] }): StoredFeeResult;
  updateFee(billId: string, feeId: string, patch: Partial<Pick<Fee, 'label' | 'cents' | 'split'>>): void;
  removeFee(billId: string, feeId: string): void;
  setTip(billId: string, tip: Tip, source: TipSource | null): void;

  addPerson(billId: string, name: string): StoredPerson;
  setClaim(billId: string, itemId: string, personId: string, mode: ClaimMode, createdBy: string): void;
  clearClaim(billId: string, itemId: string, personId: string): void;

  openBill(billId: string): void;
  markSent(billId: string): void;

  /**
   * Promotes a draft minted by `createDraftBill` (a purely local id, M3) to the real id a
   * server-backed implementation issued (M4): either the id `parse-receipt` already created for
   * a scan (passed as `serverId`, learned from the stream's `done` event), or, when `serverId` is
   * omitted, a brand new one this call creates itself (manual entry, which has no Edge Function in
   * its path - SPEC.md section 8, M4 realtime-store task). Rekeys the stored bill from `localId` to
   * the result's `id` and returns it; this in-memory implementation treats that as a pure rename.
   */
  promoteBill(localId: string, payer: { id: string; name: string }, serverId?: string): Promise<StoredBill>;
}

type StoredFeeResult = Fee;

/** Expands a parsed line into unit items (SPEC 6.5, FR-2), assigning fresh ids. */
function expandLineToItems(line: ParsedLineItem): { name: string; priceCents: number }[] {
  return allocate(line.lineTotalCents, Array<number>(line.quantity).fill(1)).map((priceCents) => ({
    name: line.name,
    priceCents,
  }));
}

export function createLocalBillStore(): BillStore {
  const bills = new Map<string, StoredBill>();

  function require(billId: string): StoredBill {
    const bill = bills.get(billId);
    if (!bill) throw new Error(`localBillStore: unknown bill ${billId}`);
    return bill;
  }

  return {
    createDraftBill(payer) {
      const id = makeLocalId('bill');
      const bill: StoredBill = {
        id,
        status: 'draft',
        title: 'New bill',
        merchantName: null,
        currency: 'USD',
        payerId: payer.id,
        people: [{ id: payer.id, name: payer.name, kind: 'payer' }],
        items: [],
        discountCents: 0,
        taxCents: 0,
        tip: { kind: 'amount', cents: 0 },
        tipSource: null,
        fees: [],
        claims: [],
        warnings: [],
        printedSubtotalCents: null,
        printedTotalCents: null,
        scanState: 'idle',
        scanError: null,
        createdAt: Date.now(),
        sentAt: null,
      };
      bills.set(id, bill);
      return bill;
    },

    getBill: (billId) => bills.get(billId),
    // Reverse insertion order first so a tied createdAt (same millisecond)
    // still puts the most recently created bill first (stable sort).
    listBills: () => [...bills.values()].reverse().sort((a, b) => b.createdAt - a.createdAt),

    beginScan(billId) {
      require(billId).scanState = 'streaming';
    },

    addStreamedLine(billId, line) {
      const bill = require(billId);
      const newItems = expandLineToItems(line).map((unit): StoredItem => ({ id: makeLocalId('item'), ...unit }));
      bill.items = [...bill.items, ...newItems];
      return newItems;
    },

    finalizeScan(billId, receipt) {
      const bill = require(billId);
      bill.scanState = 'done';
      bill.merchantName = receipt.merchantName;
      bill.title = receipt.merchantName ?? bill.title;
      bill.currency = receipt.currency;
      bill.discountCents = receipt.discountCents;
      bill.taxCents = receipt.taxCents;
      bill.fees = receipt.fees.map((fee) => ({
        id: makeLocalId('fee'),
        label: fee.label,
        cents: fee.cents,
        split: 'proportional',
      }));
      bill.tip = { kind: 'amount', cents: receipt.printedTipCents ?? 0 };
      bill.tipSource = receipt.printedTipCents === null ? null : receipt.tipSource;
      bill.warnings = receipt.warnings;
      bill.printedSubtotalCents = receipt.printedSubtotalCents;
      bill.printedTotalCents = receipt.printedTotalCents;
    },

    failScan(billId, code) {
      const bill = require(billId);
      bill.scanState = 'error';
      bill.scanError = code;
    },

    addItem(billId, item) {
      const bill = require(billId);
      const stored: StoredItem = { id: makeLocalId('item'), ...item };
      bill.items = [...bill.items, stored];
      return stored;
    },

    updateItem(billId, itemId, patch) {
      const bill = require(billId);
      bill.items = bill.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
    },

    removeItem(billId, itemId) {
      const bill = require(billId);
      bill.items = bill.items.filter((item) => item.id !== itemId);
      bill.claims = bill.claims.filter((claim) => claim.itemId !== itemId);
    },

    mergeItems(billId, itemIds) {
      const bill = require(billId);
      const toMerge = bill.items.filter((item) => itemIds.includes(item.id));
      if (toMerge.length < 2) return;
      const merged: StoredItem = {
        id: makeLocalId('item'),
        name: toMerge[0].name,
        priceCents: toMerge.reduce((sum, item) => sum + item.priceCents, 0),
      };
      bill.items = [...bill.items.filter((item) => !itemIds.includes(item.id)), merged];
      bill.claims = bill.claims.filter((claim) => !itemIds.includes(claim.itemId));
    },

    setDiscount(billId, cents) {
      require(billId).discountCents = cents;
    },
    setTax(billId, cents) {
      require(billId).taxCents = cents;
    },

    addFee(billId, fee) {
      const bill = require(billId);
      const stored: Fee = { id: makeLocalId('fee'), ...fee };
      bill.fees = [...bill.fees, stored];
      return stored;
    },
    updateFee(billId, feeId, patch) {
      const bill = require(billId);
      bill.fees = bill.fees.map((fee) => (fee.id === feeId ? { ...fee, ...patch } : fee));
    },
    removeFee(billId, feeId) {
      const bill = require(billId);
      bill.fees = bill.fees.filter((fee) => fee.id !== feeId);
    },

    setTip(billId, tip, source) {
      const bill = require(billId);
      bill.tip = tip;
      bill.tipSource = source;
    },

    addPerson(billId, name) {
      const bill = require(billId);
      const existingNames = new Set(bill.people.map((p) => p.name));
      let label = name;
      let suffix = 2;
      while (existingNames.has(label)) {
        label = `${name} (${suffix})`;
        suffix += 1;
      }
      const person: StoredPerson = { id: makeLocalId('person'), name: label, kind: 'named' };
      bill.people = [...bill.people, person];
      return person;
    },

    setClaim(billId, itemId, personId, mode, createdBy) {
      const bill = require(billId);
      const without = bill.claims.filter((claim) => !(claim.itemId === itemId && claim.personId === personId));
      bill.claims = [...without, { itemId, personId, mode, createdBy }];
    },

    clearClaim(billId, itemId, personId) {
      const bill = require(billId);
      bill.claims = bill.claims.filter((claim) => !(claim.itemId === itemId && claim.personId === personId));
    },

    openBill(billId) {
      require(billId).status = 'open';
    },

    markSent(billId) {
      require(billId).sentAt = Date.now();
    },

    async promoteBill(localId, _payer, serverId) {
      const bill = require(localId);
      const promoted: StoredBill = { ...bill, id: serverId ?? makeLocalId('bill') };
      bills.delete(localId);
      bills.set(promoted.id, promoted);
      return promoted;
    },
  };
}
