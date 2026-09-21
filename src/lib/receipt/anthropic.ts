/**
 * Minimal streaming client for the Anthropic Messages API, used by the
 * parse-receipt Edge Function. It calls the REST endpoint with `fetch` instead
 * of `@anthropic-ai/sdk` (SPEC 7.1 allows this) so the function has no npm
 * dependency to resolve in the Edge runtime, and the eval script can run the
 * same code under Node. `fetch` is injectable so tests need no API key.
 *
 * Runs in Deno and Node, so it must stay dependency-free. It never logs, and
 * never puts response bodies into errors, since those can echo the request.
 */
import { RECEIPT_JSON_SCHEMA } from './schema.ts';
import { RECEIPT_SYSTEM_PROMPT, RECEIPT_USER_PROMPT } from './prompt.ts';

export type AnthropicConfig = {
  /** Secret. Only ever read inside the Edge Function. */
  apiKey: string;
  /** From the ANTHROPIC_MODEL env var, set from the M2 eval. */
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export type Usage = { inputTokens: number; outputTokens: number };

export type UpstreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'end'; stopReason: string | null; usage: Usage };

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The Messages API request for one receipt photo, streaming, with structured output. */
export function buildReceiptRequest(
  image: Uint8Array,
  mediaType: ImageMediaType,
  config: Pick<AnthropicConfig, 'model' | 'maxTokens'>,
) {
  return {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    // Parsing is extraction, not reasoning, and latency is the headline metric.
    thinking: { type: 'disabled' },
    system: RECEIPT_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: RECEIPT_JSON_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: toBase64(image) } },
          { type: 'text', text: RECEIPT_USER_PROMPT },
        ],
      },
    ],
  };
}

/** Splits a server-sent-events byte stream into `{ event, data }` messages. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length > 0 ? { event, data: data.join('\n') } : null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const message = parse(block);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Sends one receipt photo and yields the model's text deltas as they arrive,
 * then a final `end` chunk with the stop reason and token usage. Throws
 * `UpstreamError` on any transport, HTTP, or in-stream error.
 */
export async function* streamReceiptText(
  image: Uint8Array,
  mediaType: ImageMediaType,
  config: AnthropicConfig,
): AsyncGenerator<UpstreamChunk> {
  const doFetch = config.fetch ?? fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await doFetch(`${config.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildReceiptRequest(image, mediaType, config)),
      signal,
    });
  } catch {
    throw new UpstreamError('Anthropic request failed');
  }
  if (!response.ok || !response.body) {
    // The body is not read: an error body can echo request content.
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(`Anthropic returned HTTP ${response.status}`, response.status);
  }

  let stopReason: string | null = null;
  let stopped = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  try {
    for await (const { event, data } of readSse(response.body)) {
      if (event === 'ping') continue;
      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new UpstreamError('Anthropic sent an unreadable stream event');
      }
      switch (payload.type) {
        case 'message_start':
          usage.inputTokens = payload.message?.usage?.input_tokens ?? 0;
          usage.outputTokens = payload.message?.usage?.output_tokens ?? 0;
          break;
        case 'content_block_delta':
          if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
            yield { kind: 'text', text: payload.delta.text };
          }
          break;
        case 'message_delta':
          stopReason = payload.delta?.stop_reason ?? stopReason;
          if (typeof payload.usage?.output_tokens === 'number') usage.outputTokens = payload.usage.output_tokens;
          break;
        case 'message_stop':
          stopped = true;
          break;
        case 'error':
          throw new UpstreamError(`Anthropic stream error: ${String(payload.error?.type ?? 'unknown')}`);
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('Anthropic stream was interrupted');
  }

  if (!stopped) throw new UpstreamError('Anthropic stream ended early');
  yield { kind: 'end', stopReason, usage };
}
