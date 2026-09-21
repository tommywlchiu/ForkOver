/**
 * A fake of the Anthropic Messages streaming endpoint, for tests and for
 * running the parse-receipt logic without an API key. It records the requests it
 * receives so tests can check what was sent.
 */
import type { Usage } from './anthropic.ts';

export type MockStream = {
  /** Text deltas, in order, as the model would emit them. */
  textChunks: string[];
  stopReason?: string;
  usage?: Usage;
  /** Extra raw SSE events inserted after the text, for example an `error` event. */
  trailingEvents?: object[];
  /** Skip the closing message_stop, as a dropped connection would. */
  dropAfterText?: boolean;
};

export type RecordedRequest = { url: string; headers: Record<string, string>; body: any };

const sse = (event: object) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

export function sseText(stream: MockStream): string {
  const usage = stream.usage ?? { inputTokens: 1500, outputTokens: 400 };
  const events: object[] = [
    { type: 'message_start', message: { id: 'msg_test', usage: { input_tokens: usage.inputTokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    ...stream.textChunks.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    ...(stream.trailingEvents ?? []),
  ];
  if (!stream.dropAfterText) {
    events.push(
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: stream.stopReason ?? 'end_turn' },
        usage: { output_tokens: usage.outputTokens },
      },
      { type: 'message_stop' },
    );
  }
  return events.map(sse).join('');
}

/** Splits `text` into chunks of `size` characters, the way a network might. */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** Returns a `fetch` that answers every call with `stream` (or the given failure). */
export function mockAnthropicFetch(
  respond: MockStream | { status: number } | { throws: true },
  wireChunkSize = 64,
) {
  const requests: RecordedRequest[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    if ('throws' in respond) throw new TypeError('fetch failed');
    if ('status' in respond) {
      return new Response(JSON.stringify({ error: { message: 'secret echo of the request' } }), {
        status: respond.status,
      });
    }
    const bytes = new TextEncoder().encode(sseText(respond));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += wireChunkSize) controller.enqueue(bytes.slice(i, i + wireChunkSize));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetch: fetchMock, requests };
}
