/**
 * Reads one receipt photo through Claude and yields events as they become
 * available: each line item as its object closes, then a validated receipt or
 * an error. This is the model-facing half of parse-receipt (SPEC 7.1 steps 3
 * to 5); the eval script runs it directly, and `handler.ts` adds auth, limits,
 * and storage around it.
 */
import { streamReceiptText, UpstreamError, type AnthropicConfig, type ImageMediaType, type Usage } from './anthropic.ts';
import { createItemStreamParser } from './partialJson.ts';
import { validateLineItem, validateReceipt, type ParsedLineItem, type ParsedReceipt } from './schema.ts';

/** SPEC 7.2. */
export type ParseErrorCode =
  | 'UNAUTHORIZED'
  | 'CONSENT_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'TOO_LARGE'
  | 'NOT_A_RECEIPT'
  | 'UPSTREAM_ERROR'
  | 'INVALID_OUTPUT';

export type ParseEvent =
  | ({ type: 'item' } & ParsedLineItem)
  | { type: 'done'; receipt: ParsedReceipt; usage: Usage }
  | { type: 'error'; code: ParseErrorCode };

export async function* parseReceiptImage(
  image: Uint8Array,
  mediaType: ImageMediaType,
  config: AnthropicConfig,
): AsyncGenerator<ParseEvent> {
  const parser = createItemStreamParser();
  let end: { stopReason: string | null; usage: Usage } | null = null;

  try {
    for await (const chunk of streamReceiptText(image, mediaType, config)) {
      if (chunk.kind === 'end') {
        end = chunk;
        break;
      }
      for (const raw of parser.push(chunk.text)) {
        const item = validateLineItem(raw);
        if (item.ok && item.item.lineTotalCents > 0) yield { type: 'item', ...item.item };
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      yield { type: 'error', code: 'UPSTREAM_ERROR' };
      return;
    }
    throw error;
  }

  if (end === null) {
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
    return;
  }
  // A cut-off or declined response is not a usable receipt.
  if (end.stopReason === 'refusal') {
    yield { type: 'error', code: 'UPSTREAM_ERROR' };
    return;
  }
  if (end.stopReason === 'max_tokens') {
    yield { type: 'error', code: 'INVALID_OUTPUT' };
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(parser.text);
  } catch {
    yield { type: 'error', code: 'INVALID_OUTPUT' };
    return;
  }
  const result = validateReceipt(json);
  if (!result.ok) {
    yield { type: 'error', code: result.code };
    return;
  }
  if (!result.receipt.isReceipt) {
    yield { type: 'error', code: 'NOT_A_RECEIPT' };
    return;
  }
  yield { type: 'done', receipt: dropUnpricedItems(result.receipt), usage: end.usage };
}

/**
 * A line that prints no price is not an item (SPEC 7.4). When the model returns
 * one anyway, at zero, drop it and name it in a warning for the review screen.
 */
export function dropUnpricedItems(receipt: ParsedReceipt): ParsedReceipt {
  const unpriced = receipt.items.filter((item) => item.lineTotalCents === 0);
  if (unpriced.length === 0) return receipt;
  const names = unpriced.map((item) => `"${item.name}"`).join(', ');
  return {
    ...receipt,
    items: receipt.items.filter((item) => item.lineTotalCents > 0),
    warnings: [...receipt.warnings, `No price printed for ${names}; left out of the items.`],
  };
}
