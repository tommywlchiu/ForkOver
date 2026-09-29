/**
 * A stand-in for the streamed receipt reader the app will eventually call
 * over the network (parse-receipt, SPEC 7.1). It replays a canned
 * `ParsedReceipt` behind the same event stream shape as the real reader
 * (`ReceiptReader` in src/data/receiptReader.ts), with delays between items
 * so the review screen's "items stream in" behavior can be exercised with no
 * network call and no API key (SPEC.md section 11, M3).
 */
import type { ParseEvent } from '../parseReceipt';
import type { ParsedReceipt } from '../schema';

export type StandInDelays = {
  /** Delay before each item event, simulating the model reading one line at a time. */
  perItemMs: number;
  /** Extra delay after the last item before the final `done` event. */
  tailMs: number;
};

export const DEFAULT_STAND_IN_DELAYS: StandInDelays = { perItemMs: 220, tailMs: 260 };

/** No-delay variant for tests that don't care about timing. */
export const INSTANT_STAND_IN_DELAYS: StandInDelays = { perItemMs: 0, tailMs: 0 };

const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Builds a reader that ignores the image it's given and replays `receipt`
 * instead. Matches the shape screens consume so swapping in the real
 * network call later (src/data/receiptReader.ts) is a one-place change.
 */
export function createStandInReader(receipt: ParsedReceipt, delays: StandInDelays = DEFAULT_STAND_IN_DELAYS) {
  return async function* standInReceiptReader(): AsyncGenerator<ParseEvent> {
    for (const item of receipt.items) {
      await wait(delays.perItemMs);
      yield { type: 'item', ...item };
    }
    await wait(delays.tailMs);
    yield { type: 'done', receipt, usage: { inputTokens: 0, outputTokens: 0 } };
  };
}
