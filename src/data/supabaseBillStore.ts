/**
 * The Supabase-backed `BillStore` (SPEC.md section 8, M4): replaces
 * `createLocalBillStore` behind the same interface (`src/data/localBillStore.ts`).
 * Screens and `src/state/bill.ts` are unaffected; only `src/state/bill.ts`'s
 * `createLocalBillStore()` call changes to this module's `createSupabaseBillStore()`.
 *
 * Two gaps the in-memory store never had to solve:
 *
 * 1. **Local id vs. real server id.** A draft bill starts out local-only (no
 *    server row): `createDraftBill` still mints a local id synchronously, same
 *    as before, so scan.tsx/home.tsx can navigate immediately. The *server*
 *    only learns about the scan's bill the moment `parse-receipt`'s `done`
 *    event names it (`receiptReader.ts`'s `billId`), and manual entry has no
 *    server row at all until something asks for one. `promoteBill` is the one
 *    place that gap closes: it either adopts the id the scan's `done` event
 *    already carries, or (manual entry) calls `create_manual_bill` to mint one,
 *    flushes whatever was built up locally (items, fees, tip, claims, ...) to
 *    the real row with `upsert` (so a retry after a partial failure is safe),
 *    then re-reads the bill back with `fetchSnapshot` rather than trusting its
 *    own writes succeeded, and only *then* rekeys the in-memory cache from the
 *    local id to the real one. If anything in that sequence fails - the RPC,
 *    any of the flush writes, or the final read-back - the draft is left
 *    exactly as it was, still under its local id, not promoted: nothing is
 *    silently marked synced when it isn't, and a caller can retry by calling
 *    `promoteBill` again (it remembers the server id a scan already has, so a
 *    retry never re-runs `create_manual_bill` and never risks a second phantom
 *    bill). Every item/fee/person/claim's own id is a `crypto.randomUUID()`
 *    minted up front rather than a throwaway local one, so promotion never
 *    needs to remap one a screen is already holding onto (a rendered
 *    `testID`, a selected chip, ...) - only the bill's own id and the payer's
 *    person id change (the draft's payer id is the raw auth user id; the real
 *    one is `bill_people.id`, which claims actually reference).
 *
 * 2. **Manual entry has no Edge Function in its path.** `bills` has no INSERT
 *    policy for a normal signed-in user (`bills_update_payer`'s comment: it's
 *    deliberately service-role only, parse-receipt's path). `create_manual_bill`
 *    (`supabase/migrations/20261010100000_create_manual_bill.sql`) is the
 *    `security definer` RPC that gives manual entry one, re-validating
 *    `auth.uid()` itself rather than opening a client-writable INSERT policy.
 *
 * A bill not yet promoted lives entirely in the local cache below: every
 * `BillStore` method still works against it (so `src/lib/receipt/standIn`-driven
 * tests, which never surface a real `billId` on `done`, keep working exactly
 * as they did against the in-memory store), it just never touches the network.
 * Once promoted, the same methods write through to Supabase: optimistic (the
 * cache updates immediately, SPEC 8.3 NFR-1), with the network call
 * fire-and-forget via `writeThrough` - on failure the change is rolled back and
 * `onSyncError` (if given) is told about it, so a screen can show a short error
 * (SPEC 8.3). `isPromoted` lets a screen show a persistent "not synced" state
 * (rather than just a one-off toast) when promotion itself never completed.
 */
import { supabase } from './supabaseClient';
import { ALL_BILL_TABLES } from './billTables';
import { allocate, type Fee, type Tip } from '../lib/split/split';
import type { Claim, ClaimMode } from '../lib/claims/resolve';
import type { ParsedLineItem } from '../lib/receipt/schema';
import { makeLocalId, type BillStore, type StoredBill, type StoredItem, type StoredPerson } from './localBillStore';

/** A fresh id for anything that may end up as a real row: items, fees, named people. */
function newId(): string {
  return crypto.randomUUID();
}

/** Expands a parsed line into unit items (SPEC 6.5, FR-2), assigning fresh ids. Mirrors localBillStore.ts. */
function expandLineToItems(line: ParsedLineItem): { name: string; priceCents: number }[] {
  return allocate(line.lineTotalCents, Array<number>(line.quantity).fill(1)).map((priceCents) => ({
    name: line.name,
    priceCents,
  }));
}

function tipToJson(tip: Tip): Record<string, unknown> {
  return tip.kind === 'amount' ? { kind: 'amount', cents: tip.cents } : { kind: 'percent', bps: tip.bps, base: tip.base };
}

function tipFromJson(tip: unknown): Tip {
  if (tip && typeof tip === 'object' && (tip as { kind?: string }).kind === 'percent') {
    const t = tip as { bps: number; base: 'preTax' | 'postTax' };
    return { kind: 'percent', bps: t.bps, base: t.base };
  }
  if (tip && typeof tip === 'object' && (tip as { kind?: string }).kind === 'amount') {
    return { kind: 'amount', cents: (tip as { cents: number }).cents };
  }
  return { kind: 'amount', cents: 0 };
}

type QueryResult<T = unknown> = { data: T; error: { message: string } | null };

type BillRow = {
  id: string;
  status: 'draft' | 'open' | 'closed';
  title: string | null;
  merchant_name: string | null;
  currency: string;
  discount_cents: number;
  tax_cents: number;
  tip: unknown;
  sent_at: string | null;
  created_at: string;
};
type PersonRow = { id: string; user_id: string | null; display_name: string; kind: string };
type ItemRow = { id: string; name: string; price_cents: number; position: number };
type FeeRow = { id: string; label: string; cents: number; split: 'proportional' | 'equal' };
type ClaimRow = { item_id: string; person_id: string; mode: ClaimMode; created_by: string };

/** Builds a `StoredBill` from a full server-side snapshot of one bill's rows. */
function assemble(bill: BillRow, people: PersonRow[], items: ItemRow[], fees: FeeRow[], claims: ClaimRow[], previous: StoredBill | undefined): StoredBill {
  const payer = people.find((p) => p.kind === 'payer');
  return {
    id: bill.id,
    status: bill.status,
    title: bill.title ?? previous?.title ?? 'New bill',
    merchantName: bill.merchant_name,
    currency: bill.currency,
    // `payer` should always be found - `handle_new_bill` gives every bill a payer `bill_people`
    // row the instant it's created, and `fetchSnapshot` below already refuses to call this at all
    // if the `bill_people` read itself errored. Falling back to `previous?.payerId` (the raw auth
    // user id on a still-local draft) only exists as a last-resort, should-be-unreachable default
    // for that invariant somehow not holding - never trust it as the real `bill_people.id` claims
    // reference.
    payerId: payer?.id ?? previous?.payerId ?? '',
    // Includes member/guest rows too (not just payer/named): once the join-bill flow exists
    // (out of scope here), the payer's bill screen should see their claims live without another
    // change to this module.
    people: people.map(
      (p): StoredPerson => ({
        id: p.id,
        name: p.display_name,
        kind: p.kind === 'payer' || p.kind === 'named' || p.kind === 'member' || p.kind === 'guest' ? p.kind : 'named',
      }),
    ),
    items: [...items].sort((a, b) => a.position - b.position).map((i): StoredItem => ({ id: i.id, name: i.name, priceCents: i.price_cents })),
    discountCents: bill.discount_cents,
    taxCents: bill.tax_cents,
    tip: tipFromJson(bill.tip),
    tipSource: previous?.tipSource ?? null,
    fees: fees.map((f): Fee => ({ id: f.id, label: f.label, cents: f.cents, split: f.split })),
    claims: claims.map((c): Claim => ({ itemId: c.item_id, personId: c.person_id, mode: c.mode, createdBy: c.created_by })),
    warnings: previous?.warnings ?? [],
    printedSubtotalCents: previous?.printedSubtotalCents ?? null,
    printedTotalCents: previous?.printedTotalCents ?? null,
    scanState: previous?.scanState ?? 'done',
    scanError: previous?.scanError ?? null,
    createdAt: new Date(bill.created_at).getTime(),
    sentAt: bill.sent_at ? new Date(bill.sent_at).getTime() : null,
  };
}

/**
 * Reads one bill's full state back from Supabase. Returns `null` on *any* read failing (not just
 * the bill row itself) rather than assembling a partial result from whatever did come back: a
 * silent partial result is exactly how a failed `bill_people` read could reintroduce the
 * raw-user-id payer bug, or a failed `bill_items` read could make a payer's own items look like
 * they vanished, after a realtime-triggered refetch. Callers (realtime's `onSnapshot`,
 * `promoteBill`) already treat `null` as "couldn't confirm anything changed - leave the cache
 * alone" rather than erasing good local state.
 */
async function fetchSnapshot(billId: string, previous: StoredBill | undefined): Promise<StoredBill | null> {
  const [billRes, peopleRes, itemsRes, feesRes, claimsRes] = await Promise.all([
    supabase.from('bills').select('id,status,title,merchant_name,currency,discount_cents,tax_cents,tip,sent_at,created_at').eq('id', billId).maybeSingle(),
    supabase.from('bill_people').select('id,user_id,display_name,kind').eq('bill_id', billId),
    supabase.from('bill_items').select('id,name,price_cents,position').eq('bill_id', billId),
    supabase.from('bill_fees').select('id,label,cents,split').eq('bill_id', billId),
    supabase.from('claims').select('item_id,person_id,mode,created_by').eq('bill_id', billId),
  ]);
  if (billRes.error || !billRes.data || peopleRes.error || itemsRes.error || feesRes.error || claimsRes.error) return null;
  return assemble(billRes.data as BillRow, (peopleRes.data ?? []) as PersonRow[], (itemsRes.data ?? []) as ItemRow[], (feesRes.data ?? []) as FeeRow[], (claimsRes.data ?? []) as ClaimRow[], previous);
}

/** A `BillStore` backed by Supabase. See the module doc for the two M4 gaps this closes. */
export function createSupabaseBillStore(onSyncError?: (billId: string, message: string) => void): BillStore {
  const cache = new Map<string, StoredBill>();
  /** Bill ids with a real, fully-flushed server-side row (post-`promoteBill`); everything else is local-only. */
  const promotedIds = new Set<string>();
  /** localId -> the server id a scan already created, remembered across a failed promotion so a
   *  retry never calls `create_manual_bill` for a bill that already exists (which would mint a
   *  second, orphaned one - manual entry's RPC has no idempotency key). */
  const pendingServerIds = new Map<string, string>();

  function require(billId: string): StoredBill {
    const bill = cache.get(billId);
    if (!bill) throw new Error(`supabaseBillStore: unknown bill ${billId}`);
    return bill;
  }

  function set(bill: StoredBill) {
    cache.set(bill.id, bill);
  }

  function reportError(billId: string, message: string) {
    console.warn(`[supabaseBillStore] ${message}`);
    onSyncError?.(billId, message);
  }

  /**
   * Runs one write for a bill whose local cache has already been updated optimistically; reverts
   * that change and reports a short error on failure (SPEC 8.3). Shared by every simple
   * write-through method below, so a future one can't forget to check `error` the way
   * `promoteBill`'s own writes once did.
   */
  function writeThrough(billId: string, op: PromiseLike<{ error: { message: string } | null }>, revert: () => void, message: string) {
    void op.then(({ error }) => {
      if (error) {
        revert();
        reportError(billId, message);
      }
    });
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
      set(bill);
      return bill;
    },

    getBill: (billId) => cache.get(billId),
    listBills: () => [...cache.values()].reverse().sort((a, b) => b.createdAt - a.createdAt),
    isPromoted: (billId) => promotedIds.has(billId),

    beginScan(billId) {
      require(billId).scanState = 'streaming';
    },

    // Streaming and finalizing stay purely local, even for a bill that will later be promoted:
    // the model's own read has nowhere server-side to land until the scan ends (SPEC 7.1's wire
    // protocol only names the real bill id in the final `done` event), so there is nothing to
    // write yet. `promoteBill` is what flushes this once a real id exists.
    addStreamedLine(billId, line) {
      const bill = require(billId);
      const newItems = expandLineToItems(line).map((unit): StoredItem => ({ id: newId(), ...unit }));
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
      bill.fees = receipt.fees.map((fee): Fee => ({ id: newId(), label: fee.label, cents: fee.cents, split: 'proportional' }));
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
      const stored: StoredItem = { id: newId(), ...item };
      bill.items = [...bill.items, stored];
      if (promotedIds.has(billId)) {
        const position = bill.items.length - 1;
        writeThrough(
          billId,
          supabase.from('bill_items').insert({ id: stored.id, bill_id: billId, name: stored.name, price_cents: stored.priceCents, position }),
          () => {
            bill.items = bill.items.filter((i) => i.id !== stored.id);
          },
          "Couldn't add that item. Try again.",
        );
      }
      return stored;
    },

    updateItem(billId, itemId, patch) {
      const bill = require(billId);
      const previous = bill.items.find((i) => i.id === itemId);
      bill.items = bill.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
      if (promotedIds.has(billId) && previous) {
        const dbPatch: Record<string, unknown> = {};
        if (patch.name !== undefined) dbPatch.name = patch.name;
        if (patch.priceCents !== undefined) dbPatch.price_cents = patch.priceCents;
        writeThrough(
          billId,
          supabase.from('bill_items').update(dbPatch).eq('id', itemId),
          () => {
            bill.items = bill.items.map((item) => (item.id === itemId ? previous : item));
          },
          "Couldn't save that change. Try again.",
        );
      }
    },

    removeItem(billId, itemId) {
      const bill = require(billId);
      const removedItem = bill.items.find((i) => i.id === itemId);
      const removedClaims = bill.claims.filter((c) => c.itemId === itemId);
      bill.items = bill.items.filter((item) => item.id !== itemId);
      bill.claims = bill.claims.filter((claim) => claim.itemId !== itemId);
      if (promotedIds.has(billId) && removedItem) {
        writeThrough(
          billId,
          supabase.from('bill_items').delete().eq('id', itemId),
          () => {
            bill.items = [...bill.items, removedItem];
            bill.claims = [...bill.claims, ...removedClaims];
          },
          "Couldn't remove that item. Try again.",
        );
      }
    },

    mergeItems(billId, itemIds) {
      const bill = require(billId);
      const toMerge = bill.items.filter((item) => itemIds.includes(item.id));
      if (toMerge.length < 2) return;
      const merged: StoredItem = {
        id: newId(),
        name: toMerge[0].name,
        priceCents: toMerge.reduce((sum, item) => sum + item.priceCents, 0),
      };
      const previousItems = bill.items;
      const previousClaims = bill.claims;
      bill.items = [...bill.items.filter((item) => !itemIds.includes(item.id)), merged];
      bill.claims = bill.claims.filter((claim) => !itemIds.includes(claim.itemId));
      if (promotedIds.has(billId)) {
        const position = bill.items.length - 1;
        void (async () => {
          const { error: insertError } = await supabase.from('bill_items').insert({ id: merged.id, bill_id: billId, name: merged.name, price_cents: merged.priceCents, position });
          if (insertError) {
            bill.items = previousItems;
            bill.claims = previousClaims;
            reportError(billId, "Couldn't merge those items. Try again.");
            return;
          }
          const { error: deleteError } = await supabase.from('bill_items').delete().in('id', itemIds);
          if (deleteError) {
            // The merged item now exists alongside the originals server-side (the insert above
            // succeeded; this delete didn't): force a refetch so the local cache matches reality
            // - including the stale duplicates - rather than quietly showing only the merge.
            reportError(billId, "Couldn't finish merging those items. Refreshing.");
            const snapshot = await fetchSnapshot(billId, bill);
            if (snapshot) set(snapshot);
          }
        })();
      }
    },

    setDiscount(billId, cents) {
      const bill = require(billId);
      const previous = bill.discountCents;
      bill.discountCents = cents;
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bills').update({ discount_cents: cents }).eq('id', billId),
          () => {
            bill.discountCents = previous;
          },
          "Couldn't save the discount. Try again.",
        );
      }
    },

    setTax(billId, cents) {
      const bill = require(billId);
      const previous = bill.taxCents;
      bill.taxCents = cents;
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bills').update({ tax_cents: cents }).eq('id', billId),
          () => {
            bill.taxCents = previous;
          },
          "Couldn't save the tax. Try again.",
        );
      }
    },

    addFee(billId, fee) {
      const bill = require(billId);
      const stored: Fee = { id: newId(), ...fee };
      bill.fees = [...bill.fees, stored];
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bill_fees').insert({ id: stored.id, bill_id: billId, label: stored.label, cents: stored.cents, split: stored.split }),
          () => {
            bill.fees = bill.fees.filter((f) => f.id !== stored.id);
          },
          "Couldn't add that fee. Try again.",
        );
      }
      return stored;
    },

    updateFee(billId, feeId, patch) {
      const bill = require(billId);
      const previous = bill.fees.find((f) => f.id === feeId);
      bill.fees = bill.fees.map((fee) => (fee.id === feeId ? { ...fee, ...patch } : fee));
      if (promotedIds.has(billId) && previous) {
        writeThrough(
          billId,
          supabase.from('bill_fees').update(patch).eq('id', feeId),
          () => {
            bill.fees = bill.fees.map((fee) => (fee.id === feeId ? previous : fee));
          },
          "Couldn't save that fee. Try again.",
        );
      }
    },

    removeFee(billId, feeId) {
      const bill = require(billId);
      const removed = bill.fees.find((f) => f.id === feeId);
      bill.fees = bill.fees.filter((fee) => fee.id !== feeId);
      if (promotedIds.has(billId) && removed) {
        writeThrough(
          billId,
          supabase.from('bill_fees').delete().eq('id', feeId),
          () => {
            bill.fees = [...bill.fees, removed];
          },
          "Couldn't remove that fee. Try again.",
        );
      }
    },

    setTip(billId, tip, source) {
      const bill = require(billId);
      const previous = bill.tip;
      bill.tip = tip;
      bill.tipSource = source;
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bills').update({ tip: tipToJson(tip) }).eq('id', billId),
          () => {
            bill.tip = previous;
          },
          "Couldn't save the tip. Try again.",
        );
      }
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
      const person: StoredPerson = { id: newId(), name: label, kind: 'named' };
      bill.people = [...bill.people, person];
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bill_people').insert({ id: person.id, bill_id: billId, display_name: label, kind: 'named' }),
          () => {
            bill.people = bill.people.filter((p) => p.id !== person.id);
          },
          "Couldn't add that person. Try again.",
        );
      }
      return person;
    },

    setClaim(billId, itemId, personId, mode, createdBy) {
      const bill = require(billId);
      const previous = bill.claims;
      const without = bill.claims.filter((claim) => !(claim.itemId === itemId && claim.personId === personId));
      bill.claims = [...without, { itemId, personId, mode, createdBy }];
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('claims').upsert({ item_id: itemId, person_id: personId, bill_id: billId, mode, created_by: createdBy }),
          () => {
            bill.claims = previous;
          },
          "Couldn't save that claim. Try again.",
        );
      }
    },

    clearClaim(billId, itemId, personId) {
      const bill = require(billId);
      const previous = bill.claims;
      bill.claims = bill.claims.filter((claim) => !(claim.itemId === itemId && claim.personId === personId));
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('claims').delete().eq('item_id', itemId).eq('person_id', personId),
          () => {
            bill.claims = previous;
          },
          "Couldn't clear that claim. Try again.",
        );
      }
    },

    openBill(billId) {
      const bill = require(billId);
      const previous = bill.status;
      bill.status = 'open';
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bills').update({ status: 'open' }).eq('id', billId),
          () => {
            bill.status = previous;
          },
          "Couldn't open the bill. Try again.",
        );
      }
    },

    markSent(billId) {
      const bill = require(billId);
      const previous = bill.sentAt;
      bill.sentAt = Date.now();
      if (promotedIds.has(billId)) {
        writeThrough(
          billId,
          supabase.from('bills').update({ sent_at: new Date(bill.sentAt).toISOString() }).eq('id', billId),
          () => {
            bill.sentAt = previous;
          },
          "Couldn't mark the bill sent. Try again.",
        );
      }
    },

    async promoteBill(localId, payer, serverId) {
      const draft = require(localId);

      // A retry reuses the server id a previous attempt already has (scan: parse-receipt created
      // it regardless of whether the flush below succeeded; manual entry: the RPC call below
      // created it) - never re-run `create_manual_bill` for a bill that might already exist.
      let billId: string | null = serverId ?? pendingServerIds.get(localId) ?? null;
      if (!billId) {
        const { data, error } = await supabase.rpc('create_manual_bill');
        if (error || !data) {
          reportError(localId, "Couldn't create the bill. Check your connection and try again.");
          return draft;
        }
        billId = (data as { id: string }).id;
      }
      pendingServerIds.set(localId, billId);

      // Resolve the real payer `bill_people` id *before* building anything that references a
      // person: a claim made before promotion has `personId`/`createdBy` set to the draft's
      // payer id, which is the raw auth user id (`createDraftBill`'s own shape), not the
      // `bill_people.id` claims actually reference server-side. Without this remap, a claim made
      // during review/manual entry would silently point at the wrong id the moment it's flushed
      // (code review on PR #31).
      const { data: peopleBeforeFlush, error: peopleError } = await supabase.from('bill_people').select('id,user_id,display_name,kind').eq('bill_id', billId);
      const realPayerId = (peopleBeforeFlush ?? []).find((p) => p.kind === 'payer')?.id;
      if (peopleError || !realPayerId) {
        reportError(localId, "Couldn't finish saving this bill. Try again.");
        return draft;
      }
      const remapPerson = (id: string) => (id === draft.payerId ? realPayerId : id);

      const hasContent =
        draft.title !== 'New bill' ||
        draft.merchantName !== null ||
        draft.currency !== 'USD' ||
        draft.discountCents !== 0 ||
        draft.taxCents !== 0 ||
        draft.tip.kind === 'percent' ||
        draft.tip.cents !== 0;

      // Every write below uses `upsert`, not `insert`: a retry after a partial failure must be
      // able to re-run the same writes without a duplicate-key conflict on whatever did land last
      // time (every row already carries a stable client-generated id).
      const results: QueryResult[] = await Promise.all([
        hasContent
          ? supabase
              .from('bills')
              .update({
                title: draft.title,
                merchant_name: draft.merchantName,
                currency: draft.currency,
                discount_cents: draft.discountCents,
                tax_cents: draft.taxCents,
                tip: tipToJson(draft.tip),
              })
              .eq('id', billId)
          : Promise.resolve({ data: null, error: null }),
        draft.items.length > 0
          ? supabase.from('bill_items').upsert(draft.items.map((item, position) => ({ id: item.id, bill_id: billId, name: item.name, price_cents: item.priceCents, position })))
          : Promise.resolve({ data: null, error: null }),
        draft.fees.length > 0
          ? supabase.from('bill_fees').upsert(draft.fees.map((fee) => ({ id: fee.id, bill_id: billId, label: fee.label, cents: fee.cents, split: fee.split })))
          : Promise.resolve({ data: null, error: null }),
        draft.claims.length > 0
          ? supabase.from('claims').upsert(draft.claims.map((c) => ({ item_id: c.itemId, person_id: remapPerson(c.personId), bill_id: billId, mode: c.mode, created_by: remapPerson(c.createdBy) })))
          : Promise.resolve({ data: null, error: null }),
      ]);
      const writeFailed = results.some((r) => r.error);

      // Read the bill back rather than trusting the writes above succeeded (or hand-assembling
      // the promoted bill from `draft`, which is what let a failed `bill_people` read silently
      // fall back to the raw auth user id as `payerId` before): `fetchSnapshot` itself refuses to
      // return anything unless every one of its reads succeeded.
      const snapshot = await fetchSnapshot(billId, draft);
      if (writeFailed || !snapshot) {
        reportError(localId, "Couldn't finish saving this bill. Try again.");
        return draft;
      }

      pendingServerIds.delete(localId);
      cache.delete(localId);
      set(snapshot);
      promotedIds.add(billId);
      return snapshot;
    },
  };
}

// `bills` itself is keyed by `id`, not `bill_id`, so it gets its own filter below.
const CHANGE_TABLES = ALL_BILL_TABLES.filter((table) => table !== 'bills');

/**
 * Subscribes to Postgres changes for one bill, across every table a member or the payer can
 * affect (SPEC 8.3), refetching the full snapshot on any change and handing it to `onSnapshot`.
 * Returns an unsubscribe function. Call again after reconnecting (SPEC 8.3's "on reconnect
 * refetch the bill snapshot and resubscribe") - this module does the refetch, the caller just
 * needs to re-call this to resubscribe the realtime channel itself.
 *
 * Requires `bills`/`bill_people`/`bill_items`/`bill_fees`/`claims`/`assignments`/`payments` to be
 * added to the `supabase_realtime` publication (a migration, run once per project via `db push` -
 * see `supabase/migrations/20261011000000_enable_bill_realtime.sql`); Supabase Realtime only
 * fans out Postgres changes for tables explicitly in that publication.
 *
 * `getPrevious` is called fresh on every refetch (not just once, when the subscription starts) so
 * the fields `assemble()` has no DB column for (`tipSource`, `warnings`, `scanState`, ...) fall
 * back to whatever the store holds *now*, not whatever it held when this screen first mounted.
 */
export function subscribeToBillChanges(billId: string, onSnapshot: (bill: StoredBill | null) => void, getPrevious: () => StoredBill | undefined): () => void {
  const refetch = async () => {
    const snapshot = await fetchSnapshot(billId, getPrevious());
    onSnapshot(snapshot);
  };

  let channel = supabase.channel(`bill:${billId}`);
  for (const table of CHANGE_TABLES) {
    channel = channel.on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table, filter: `bill_id=eq.${billId}` } as never,
      () => void refetch(),
      // Casts above: @supabase/supabase-js's `.on` overloads are generic over the event/table
      // literal; this module subscribes to the same filter shape across several tables in a loop
      // rather than one near-identical call per table, which the overloads aren't shaped for.
    );
  }
  // `bills` itself is keyed by `id`, not `bill_id` - give it its own filter.
  channel = channel.on('postgres_changes' as never, { event: '*', schema: 'public', table: 'bills', filter: `id=eq.${billId}` } as never, () => void refetch());
  channel.subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export { fetchSnapshot as fetchBillSnapshot };
