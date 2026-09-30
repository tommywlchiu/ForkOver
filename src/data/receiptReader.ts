/**
 * The one place the app decides how to read a receipt photo. M3 always
 * returns the stand-in reader (no backend yet, SPEC.md section 11); wiring in
 * the real `parse-receipt` Edge Function later — POST the image, adapt its
 * NDJSON response (`WireEvent` in src/lib/receipt/handler.ts) into this same
 * `ParseEvent` stream — is a one-line change to `getReceiptReader`.
 */
import type { ParseEvent } from '../lib/receipt/parseReceipt';
import { createStandInReader } from '../lib/receipt/standIn/standInReader';
import { REALISTIC_RECEIPT } from '../lib/receipt/standIn/scenarios';

export type ImageCapture = { uri: string; bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };

export type ReceiptReader = (image: ImageCapture) => AsyncGenerator<ParseEvent>;

/** Always the stand-in reader for now; see the module doc above. */
export function getReceiptReader(): ReceiptReader {
  const standIn = createStandInReader(REALISTIC_RECEIPT);
  return () => standIn();
}
