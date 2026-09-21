/**
 * The parse-receipt request handler: auth, consent, limits, image storage, and
 * the streamed newline-delimited JSON response. See SPEC.md section 7.1. The
 * model call itself is `parseReceiptImage`. Everything that touches Supabase
 * comes in through `ParseReceiptDeps`, so this file has no I/O of its own and
 * tests need neither a database nor an API key.
 */
import type { AnthropicConfig, ImageMediaType } from './anthropic.ts';
import { parseReceiptImage, type ParseErrorCode } from './parseReceipt.ts';
import type { ParsedLineItem, ParsedReceipt } from './schema.ts';

export type ParseReceiptDeps = {
  /** Resolves the caller from the request's credentials, or null when they are missing or invalid. */
  authenticate(req: Request): Promise<{ userId: string; isAnonymous: boolean } | null>;
  /** True when the profile has a recorded `ai_consent_at`. */
  hasAiConsent(userId: string): Promise<boolean>;
  /**
   * Applies the rate limit (10 scans per rolling hour) and, for free users,
   * the monthly quota (3 per UTC month), and records this attempt against the
   * hourly limit. Does not count a quota use; that happens on success.
   */
  checkLimits(userId: string): Promise<'ok' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED'>;
  /** Creates the `draft` bill for this scan and returns its id. */
  createDraftBill(userId: string): Promise<string>;
  /** Writes the photo to the private receipts bucket. Never log `image`. */
  storeReceiptImage(billId: string, image: Uint8Array, mediaType: ImageMediaType): Promise<void>;
  /** Best-effort cleanup of a draft whose scan failed. */
  discardDraftBill(billId: string): Promise<void>;
  /** Counts one successful scan against the monthly quota. */
  recordSuccessfulScan(userId: string): Promise<void>;
  anthropic: AnthropicConfig;
  /** From the MAX_IMAGE_BYTES env var. */
  maxImageBytes: number;
};

/** The events on the wire: one JSON object per line. */
export type WireEvent =
  | ({ type: 'item' } & ParsedLineItem)
  | { type: 'done'; billId: string; receipt: ParsedReceipt }
  | { type: 'error'; code: ParseErrorCode };

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

const STATUS_FOR_ERROR: Record<ParseErrorCode, number> = {
  UNAUTHORIZED: 401,
  CONSENT_REQUIRED: 403,
  QUOTA_EXCEEDED: 402,
  RATE_LIMITED: 429,
  TOO_LARGE: 413,
  NOT_A_RECEIPT: 422,
  UPSTREAM_ERROR: 502,
  INVALID_OUTPUT: 502,
};

const IMAGE_TYPES: readonly ImageMediaType[] = ['image/jpeg', 'image/png', 'image/webp'];

const encoder = new TextEncoder();
const line = (event: WireEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

const errorResponse = (code: ParseErrorCode) =>
  new Response(line({ type: 'error', code }), {
    status: STATUS_FOR_ERROR[code],
    headers: { 'content-type': NDJSON_CONTENT_TYPE },
  });

/** Reads the request body, giving up as soon as it passes `limit` bytes. */
async function readBody(req: Request, limit: number): Promise<Uint8Array | 'TOO_LARGE'> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return 'TOO_LARGE';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * POST with the photo as the request body (`Content-Type: image/jpeg`, or png
 * or webp) and the user's session in `Authorization`. Failures before the model
 * is called come back as a single error event with a matching HTTP status.
 * After that the response is a 200 stream of events: `item` per line item,
 * then `done` or `error`.
 */
export async function handleParseReceipt(req: Request, deps: ParseReceiptDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

  const user = await deps.authenticate(req);
  if (!user || user.isAnonymous) return errorResponse('UNAUTHORIZED');
  if (!(await deps.hasAiConsent(user.userId))) return errorResponse('CONSENT_REQUIRED');

  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType as ImageMediaType)) return errorResponse('NOT_A_RECEIPT');

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > deps.maxImageBytes) return errorResponse('TOO_LARGE');

  const limit = await deps.checkLimits(user.userId);
  if (limit !== 'ok') return errorResponse(limit);

  const image = await readBody(req, deps.maxImageBytes);
  if (image === 'TOO_LARGE') return errorResponse('TOO_LARGE');
  if (image.byteLength === 0) return errorResponse('NOT_A_RECEIPT');

  const abort = new AbortController();
  const anthropic: AnthropicConfig = { ...deps.anthropic, signal: abort.signal };
  const events = run(user.userId, image, mediaType as ImageMediaType, anthropic, deps);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) controller.close();
      else controller.enqueue(line(next.value));
    },
    async cancel() {
      // The app went away: stop paying for tokens nobody will read.
      abort.abort();
      await events.return(undefined);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': NDJSON_CONTENT_TYPE } });
}

async function* run(
  userId: string,
  image: Uint8Array,
  mediaType: ImageMediaType,
  anthropic: AnthropicConfig,
  deps: ParseReceiptDeps,
): AsyncGenerator<WireEvent> {
  // The draft bill and photo upload run in parallel with the model call.
  let draftId: string | null = null;
  const stored = deps.createDraftBill(userId).then(async (billId) => {
    draftId = billId;
    await deps.storeReceiptImage(billId, image, mediaType);
    return billId;
  });
  // Awaited below; this keeps a failure during the model call from surfacing as unhandled.
  stored.catch(() => undefined);

  let completed = false;
  let receipt: ParsedReceipt | null = null;
  try {
    for await (const event of parseReceiptImage(image, mediaType, anthropic)) {
      if (event.type === 'item') {
        yield event;
      } else if (event.type === 'error') {
        yield event;
        return;
      } else {
        receipt = event.receipt;
      }
    }
    if (receipt === null) throw new Error('parse ended without a result');

    const billId = await stored;
    await deps.recordSuccessfulScan(userId);
    completed = true;
    yield { type: 'done', billId, receipt };
  } catch (error) {
    // Storage or database trouble, not the model. Never include image data.
    console.error('parse-receipt failed:', error instanceof Error ? error.message : 'unknown error');
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
  } finally {
    // Runs on every exit, including the app disconnecting mid-scan.
    if (!completed) {
      await stored.catch(() => undefined);
      if (draftId) await deps.discardDraftBill(draftId).catch(() => undefined);
    }
  }
}
