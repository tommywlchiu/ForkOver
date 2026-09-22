import type { ImageMediaType, Usage } from '../anthropic.ts';
import type { ParsedReceipt } from '../schema.ts';
import type { ExpectedReceipt, ReceiptKind } from './expected.ts';
import type { Score } from './score.ts';

export type EvalFixture = {
  name: string;
  image: Uint8Array;
  mediaType: ImageMediaType;
  expected: ExpectedReceipt;
  kinds: ReceiptKind[];
};

/** One fixture read by one model. */
export type ScanResult = {
  fixture: string;
  model: string;
  /** Null when the scan succeeded, otherwise the wire error code (SPEC 7.2). */
  errorCode: string | null;
  receipt: ParsedReceipt | null;
  score: Score | null;
  /** Milliseconds from sending the photo to the first item event, and to the done event. */
  firstItemMs: number | null;
  doneMs: number | null;
  /** Token usage, known only for scans that parsed successfully. */
  usage: Usage | null;
  /** Integer micro-dollars, or null when the tokens or the model's price are unknown. */
  costMicroUsd: number | null;
};
