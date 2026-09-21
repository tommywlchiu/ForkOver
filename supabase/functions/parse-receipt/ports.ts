/**
 * The data-layer half of parse-receipt's dependencies: consent, limits, draft
 * bills, and photo storage. They read and write tables that later milestones
 * create (profiles and bills in M3/M4, quota and rate limit in M6, SPEC 8.1),
 * so for now each one fails closed: the function boots and answers, but no scan
 * gets past the consent check until these are implemented against real tables.
 */
import type { ParseReceiptDeps } from '../../../src/lib/receipt/handler.ts';

const notWired = (name: string) => () => {
  throw new Error(`parse-receipt: ${name} is not wired to the database yet (needs the M3/M4/M6 migrations)`);
};

export const dataPorts: Pick<
  ParseReceiptDeps,
  'hasAiConsent' | 'checkLimits' | 'createDraftBill' | 'storeReceiptImage' | 'discardDraftBill' | 'recordSuccessfulScan'
> = {
  hasAiConsent: notWired('hasAiConsent'),
  checkLimits: notWired('checkLimits'),
  createDraftBill: notWired('createDraftBill'),
  storeReceiptImage: notWired('storeReceiptImage'),
  discardDraftBill: notWired('discardDraftBill'),
  recordSuccessfulScan: notWired('recordSuccessfulScan'),
};
