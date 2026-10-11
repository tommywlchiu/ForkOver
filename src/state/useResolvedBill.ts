/**
 * Resolves a route's bill id to its current `StoredBill`, centrally handling four things every
 * bill screen needs (SPEC.md section 8.3, M4) - code review on PR #31 found each missing from at
 * least one of review.tsx/share.tsx/bill/[id]/index.tsx, since each had wired them in by hand:
 *
 * - The local-id -> real-id rekey fallback: a scan's draft bill may still be mounted under its
 *   pre-promotion local id when `promoteBill` rekeys it mid-flight (`src/state/bill.ts`
 *   `renamedBillIds`) - without this fallback, the screen's `bill` would go `undefined` right as
 *   promotion completes.
 * - Disabling mutating controls while offline, so an edit doesn't quietly fail later via the
 *   optimistic-write rollback with no banner ever shown (every screen that calls `addItem`/
 *   `setClaim`/etc. needs this, not just the live bill screen).
 * - Surfacing a sync error (`syncErrors`, a one-off toast) and a persistent "not synced" state
 *   with a retry (`unsyncedBillIds`/`retrySync`) when promotion itself never completed - every
 *   future edit on an unpromoted bill stays local-only until this resolves.
 * - Subscribing to realtime changes for the resolved bill (and resubscribing when the resolved id
 *   itself changes, e.g. promotion), plus refetching on reconnect (SPEC 8.3) - the second round of
 *   review found this wired into `bill/[id]/index.tsx` only, the same "fixed on one screen, not
 *   the other two" shape as the first two items above. Every bill screen gets this just by
 *   calling this hook now, not by remembering to copy the two `useEffect`s a fourth time.
 */
import { useEffect, useRef } from 'react';
import { useBillStore } from './bill';
import { useConnectivityStore } from './connectivity';
import type { StoredBill } from '../data/localBillStore';

export type ResolvedBill = {
  bill: StoredBill | undefined;
  /** Whether mutating controls (claim, edit, add) should be disabled right now. */
  controlsDisabled: boolean;
  isConnected: boolean;
  /** A one-off write failure's short message, if any (SPEC 8.3). */
  syncError: string | undefined;
  dismissSyncError: () => void;
  /** True once promotion itself has been attempted and failed - a persistent state, not a toast. */
  notSynced: boolean;
  retrySync: () => void;
};

export function useResolvedBill(routeBillId: string): ResolvedBill {
  const bill = useBillStore((s) => s.bills[routeBillId] ?? s.bills[s.renamedBillIds[routeBillId]]);
  const isConnected = useConnectivityStore((s) => s.isConnected);
  const syncError = useBillStore((s) => (bill ? s.syncErrors[bill.id] : undefined));
  const dismissSyncErrorAction = useBillStore((s) => s.dismissSyncError);
  const notSynced = useBillStore((s) => (bill ? !!s.unsyncedBillIds[bill.id] : false));
  const retrySyncAction = useBillStore((s) => s.retrySync);
  const subscribeToBill = useBillStore((s) => s.subscribeToBill);
  const refetchBill = useBillStore((s) => s.refetchBill);

  // The resolved real bill id, not the raw route param - a scan's draft bill may still be mounted
  // under its local id, which realtime has nothing to subscribe to.
  const resolvedBillId = bill?.id;

  useEffect(() => {
    if (!resolvedBillId) return undefined;
    const unsubscribe = subscribeToBill(resolvedBillId);
    return unsubscribe;
  }, [resolvedBillId, subscribeToBill]);

  const wasConnected = useRef(isConnected);
  useEffect(() => {
    if (isConnected && !wasConnected.current && resolvedBillId) void refetchBill(resolvedBillId);
    wasConnected.current = isConnected;
  }, [isConnected, resolvedBillId, refetchBill]);

  return {
    bill,
    controlsDisabled: !isConnected,
    isConnected,
    syncError,
    dismissSyncError: () => {
      if (bill) dismissSyncErrorAction(bill.id);
    },
    notSynced,
    retrySync: () => {
      if (bill) void retrySyncAction(bill.id);
    },
  };
}
