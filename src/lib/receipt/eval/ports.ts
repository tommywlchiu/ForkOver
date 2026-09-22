/**
 * In-memory stand-ins for the data-layer ports of `ParseReceiptDeps`: consent,
 * limits, draft bills, and photo storage. They exist only for the eval tooling.
 * The deployed function never imports this file (its ports are in
 * supabase/functions/parse-receipt/ports.ts).
 */
import type { ParseReceiptDeps } from '../handler.ts';

export type EvalPorts = Pick<
  ParseReceiptDeps,
  | 'authenticate'
  | 'hasAiConsent'
  | 'checkLimits'
  | 'createDraftBill'
  | 'storeReceiptImage'
  | 'discardDraftBill'
  | 'recordSuccessfulScan'
> & {
  /** Everything the handler did through the ports, in order, for tests. */
  log: string[];
};

export function createEvalPorts(): EvalPorts {
  const log: string[] = [];
  let bills = 0;
  return {
    log,
    authenticate: async () => ({ userId: 'eval-user', isAnonymous: false }),
    hasAiConsent: async () => true,
    checkLimits: async () => 'ok',
    createDraftBill: async () => {
      bills += 1;
      log.push('createDraftBill');
      return `eval-bill-${bills}`;
    },
    storeReceiptImage: async (billId) => {
      log.push(`storeReceiptImage:${billId}`);
    },
    discardDraftBill: async (billId) => {
      log.push(`discardDraftBill:${billId}`);
    },
    recordSuccessfulScan: async () => {
      log.push('recordSuccessfulScan');
    },
  };
}
