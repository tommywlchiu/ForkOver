import { toBase64, type AnthropicConfig } from './anthropic';
import { sampleReceipt } from './fixtures';
import { chunkText, mockAnthropicFetch, type MockStream } from './mockAnthropic';
import { dropUnpricedItems, parseReceiptImage, type ParseEvent } from './parseReceipt';
import { RECEIPT_JSON_SCHEMA } from './schema';

const image = new Uint8Array([1, 2, 3, 250, 251, 252]);
const receiptText = JSON.stringify(sampleReceipt);

const configFor = (fetch: typeof globalThis.fetch): AnthropicConfig => ({
  apiKey: 'sk-ant-test-key',
  model: 'claude-haiku-4-5-20251001',
  fetch,
});

const collect = async (stream: MockStream | { status: number } | { throws: true }, wireChunkSize?: number) => {
  const mock = mockAnthropicFetch(stream, wireChunkSize);
  const events: ParseEvent[] = [];
  for await (const event of parseReceiptImage(image, 'image/jpeg', configFor(mock.fetch))) events.push(event);
  return { events, requests: mock.requests };
};

describe('parseReceiptImage', () => {
  it('emits each item, then done with the validated receipt and token usage', async () => {
    const { events } = await collect({
      textChunks: chunkText(receiptText, 25),
      usage: { inputTokens: 2900, outputTokens: 610 },
    });
    expect(events).toEqual([
      { type: 'item', ...sampleReceipt.items[0] },
      { type: 'item', ...sampleReceipt.items[1] },
      { type: 'done', receipt: sampleReceipt, usage: { inputTokens: 2900, outputTokens: 610 } },
    ]);
  });

  it('emits an item before the rest of the receipt has arrived', async () => {
    const mock = mockAnthropicFetch({
      textChunks: [receiptText.slice(0, receiptText.indexOf('"Katsu"')), receiptText.slice(receiptText.indexOf('"Katsu"'))],
    });
    const stream = parseReceiptImage(image, 'image/jpeg', configFor(mock.fetch));
    const first = await stream.next();
    expect(first.value).toEqual({ type: 'item', ...sampleReceipt.items[0] });
    const seen = [first.value];
    for await (const event of stream) seen.push(event);
    expect(seen.map((e) => e?.type)).toEqual(['item', 'item', 'done']);
  });

  it('gives the same result however the network chunks the stream', async () => {
    for (const wireChunkSize of [1, 7, 4096]) {
      const { events } = await collect({ textChunks: chunkText(receiptText, 10) }, wireChunkSize);
      expect(events.at(-1)).toMatchObject({ type: 'done', receipt: sampleReceipt });
      expect(events.filter((e) => e.type === 'item')).toHaveLength(2);
    }
  });

  it('sends the photo, the JSON schema, and the configured model to the Messages API', async () => {
    const { requests } = await collect({ textChunks: [receiptText] });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      stream: true,
      output_config: { format: { type: 'json_schema', schema: RECEIPT_JSON_SCHEMA } },
    });
    expect(request.body.system).toEqual(expect.stringContaining('minor units'));
    expect(request.body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: toBase64(image) },
    });
    expect(JSON.stringify(request.body)).not.toContain('sk-ant-test-key');
  });

  it('honors a custom base URL', async () => {
    const mock = mockAnthropicFetch({ textChunks: [receiptText] });
    const config = { ...configFor(mock.fetch), baseUrl: 'http://localhost:9999' };
    for await (const event of parseReceiptImage(image, 'image/png', config)) void event;
    expect(mock.requests[0].url).toBe('http://localhost:9999/v1/messages');
    expect(mock.requests[0].body.messages[0].content[0].source.media_type).toBe('image/png');
  });

  describe('upstream failures', () => {
    it.each([400, 401, 429, 500, 529])('reports UPSTREAM_ERROR for HTTP %i without leaking the body', async (status) => {
      const { events } = await collect({ status });
      expect(events).toEqual([{ type: 'error', code: 'UPSTREAM_ERROR' }]);
    });

    it('reports UPSTREAM_ERROR when the request cannot be sent', async () => {
      const { events } = await collect({ throws: true });
      expect(events).toEqual([{ type: 'error', code: 'UPSTREAM_ERROR' }]);
    });

    it('reports UPSTREAM_ERROR for an error event mid-stream, after items already streamed', async () => {
      const { events } = await collect({
        textChunks: [receiptText.slice(0, receiptText.indexOf('"Katsu"'))],
        trailingEvents: [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
        dropAfterText: true,
      });
      expect(events.map((e) => e.type)).toEqual(['item', 'error']);
      expect(events.at(-1)).toEqual({ type: 'error', code: 'UPSTREAM_ERROR' });
    });

    it('reports UPSTREAM_ERROR when the stream ends before the message completes', async () => {
      const { events } = await collect({ textChunks: [receiptText], dropAfterText: true });
      expect(events.at(-1)).toEqual({ type: 'error', code: 'UPSTREAM_ERROR' });
    });

    it('reports UPSTREAM_ERROR when the model declines', async () => {
      const { events } = await collect({ textChunks: [], stopReason: 'refusal' });
      expect(events).toEqual([{ type: 'error', code: 'UPSTREAM_ERROR' }]);
    });
  });

  describe('unusable output', () => {
    it('reports INVALID_OUTPUT when the response was cut off at max_tokens', async () => {
      const { events } = await collect({ textChunks: [receiptText.slice(0, 200)], stopReason: 'max_tokens' });
      expect(events.at(-1)).toEqual({ type: 'error', code: 'INVALID_OUTPUT' });
    });

    it('reports INVALID_OUTPUT when the text is not JSON', async () => {
      const { events } = await collect({ textChunks: ['Sorry, I could not read that.'] });
      expect(events).toEqual([{ type: 'error', code: 'INVALID_OUTPUT' }]);
    });

    it('reports INVALID_OUTPUT when the JSON breaks the schema, and never emits the bad item', async () => {
      const bad = { ...sampleReceipt, items: [{ name: 'Beer', quantity: 0, lineTotalCents: 500 }, sampleReceipt.items[1]] };
      const { events } = await collect({ textChunks: chunkText(JSON.stringify(bad), 30) });
      expect(events).toEqual([
        { type: 'item', ...sampleReceipt.items[1] },
        { type: 'error', code: 'INVALID_OUTPUT' },
      ]);
    });

    it('reports INVALID_OUTPUT for an unknown currency', async () => {
      const { events } = await collect({ textChunks: [JSON.stringify({ ...sampleReceipt, currency: 'ZZZ' })] });
      expect(events.at(-1)).toEqual({ type: 'error', code: 'INVALID_OUTPUT' });
    });
  });

  it('never emits a row that prints no price, and leaves it out of the receipt with a warning', async () => {
    const withUnpriced = {
      ...sampleReceipt,
      items: [sampleReceipt.items[0], { name: 'Omakase F', quantity: 1, lineTotalCents: 0 }, sampleReceipt.items[1]],
    };
    const { events } = await collect({ textChunks: chunkText(JSON.stringify(withUnpriced), 30) });
    expect(events.filter((e) => e.type === 'item')).toEqual([
      { type: 'item', ...sampleReceipt.items[0] },
      { type: 'item', ...sampleReceipt.items[1] },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      receipt: { items: sampleReceipt.items, warnings: ['No price printed for "Omakase F"; left out of the items.'] },
    });
  });

  it('reports NOT_A_RECEIPT when the model says the photo is not a receipt', async () => {
    const notReceipt = { ...sampleReceipt, isReceipt: false, items: [], fees: [], currency: '' };
    const { events } = await collect({ textChunks: [JSON.stringify(notReceipt)] });
    expect(events).toEqual([{ type: 'error', code: 'NOT_A_RECEIPT' }]);
  });
});

describe('dropUnpricedItems', () => {
  it('returns the receipt unchanged when every item has a price', () => {
    expect(dropUnpricedItems(sampleReceipt)).toBe(sampleReceipt);
  });

  it('drops every zero-price item and names them all in one warning after the model\'s own', () => {
    const receipt = {
      ...sampleReceipt,
      items: [
        { name: 'Set A', quantity: 1, lineTotalCents: 0 },
        ...sampleReceipt.items,
        { name: 'No rice', quantity: 1, lineTotalCents: 0 },
      ],
      warnings: ['Top of receipt is folded'],
    };
    expect(dropUnpricedItems(receipt)).toEqual({
      ...sampleReceipt,
      warnings: ['Top of receipt is folded', 'No price printed for "Set A", "No rice"; left out of the items.'],
    });
  });
});
