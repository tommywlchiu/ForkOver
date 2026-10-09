/**
 * The one place the app decides how to read a receipt photo. Calls the
 * `parse-receipt` Edge Function (SPEC.md section 7.1) with the image bytes
 * and the signed-in user's session token, and adapts its newline-delimited
 * JSON response (`WireEvent` in supabase/functions/parse-receipt's
 * src/lib/receipt/handler.ts) into this module's `ParseEvent` stream
 * (src/lib/receipt/parseReceipt.ts).
 *
 * The wire and client shapes differ on `done`: the wire event is
 * `{ type: 'done', billId, receipt }` (no `usage`, since the model-usage
 * figure is internal to the function), while `ParseEvent`'s `done` carries an
 * optional `usage` (set by parseReceiptImage's own direct callers, the eval
 * script) and an optional `billId` (set here, carried forward for the bill
 * store - unused today, SPEC M4 may want it for shared-bill sync). Neither
 * field is required, so this reader satisfies the same type with no cast.
 *
 * Streaming note (SPEC.md section 11, M3; see AGENTS.md's Expo docs rule):
 * fetch's streaming support has historically been inconsistent on React
 * Native/Hermes. Expo SDK 57 installs `expo/fetch` (a WinterCG-compliant
 * fetch, https://docs.expo.dev/versions/v57.0.0/sdk/expo/) as the *global*
 * `fetch` on Android and iOS specifically to fix this, with a real
 * `ReadableStream`/`getReader()` on native. This file imports it by name
 * rather than relying on the global, so the choice is explicit and holds even
 * if `EXPO_PUBLIC_USE_RN_FETCH=1` opts the rest of the app back into RN's
 * built-in fetch. This machine has no iOS/Android runtime, so true
 * item-by-item streaming on native is reasoned about from Expo's docs, not
 * verified directly here; the web platform (verified) and the stand-in path
 * (used by every test) both stream today.
 */
import { fetch as expoFetch } from 'expo/fetch';
import { supabase } from './supabaseClient';
import type { ParseErrorCode, ParseEvent } from '../lib/receipt/parseReceipt';

export type ImageCapture = { uri: string; bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' };

export type ReceiptReader = (image: ImageCapture) => AsyncGenerator<ParseEvent>;

/** Mirrors `WireEvent` in supabase/functions/parse-receipt/src/lib/receipt/handler.ts. */
type WireEvent =
  | ({ type: 'item' } & Omit<Extract<ParseEvent, { type: 'item' }>, 'type'>)
  | { type: 'done'; billId: string; receipt: Extract<ParseEvent, { type: 'done' }>['receipt'] }
  | { type: 'error'; code: ParseErrorCode };

function functionsUrl(): string {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('EXPO_PUBLIC_SUPABASE_URL must be set.');
  return `${base.replace(/\/$/, '')}/functions/v1/parse-receipt`;
}

/** Adapts one line of the wire's NDJSON into this module's `ParseEvent`. */
function adapt(wire: WireEvent): ParseEvent {
  if (wire.type === 'done') return { type: 'done', receipt: wire.receipt, billId: wire.billId };
  return wire;
}

/** Splits a decoded text stream on newlines, yielding each complete line as it arrives. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) yield l;
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function* readFromNetwork(image: ImageCapture): AsyncGenerator<ParseEvent> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    yield { type: 'error', code: 'UNAUTHORIZED' };
    return;
  }

  let response: Response;
  try {
    response = await expoFetch(functionsUrl(), {
      method: 'POST',
      headers: {
        'content-type': image.mediaType,
        authorization: `Bearer ${session.access_token}`,
      },
      body: image.bytes as BodyInit,
    });
  } catch {
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
    return;
  }

  if (!response.body) {
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
    return;
  }

  try {
    for await (const line of readLines(response.body)) {
      yield adapt(JSON.parse(line) as WireEvent);
    }
  } catch {
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
  }
}

/** Always the real network reader; see the module doc above. */
export function getReceiptReader(): ReceiptReader {
  return (image) => readFromNetwork(image);
}
