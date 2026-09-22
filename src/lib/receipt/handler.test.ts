import { sampleReceipt } from './fixtures';
import { handleParseReceipt, NDJSON_CONTENT_TYPE, type ParseReceiptDeps, type WireEvent } from './handler';
import { chunkText, mockAnthropicFetch, type MockStream } from './mockAnthropic';

const receiptText = JSON.stringify(sampleReceipt);
const goodStream: MockStream = { textChunks: chunkText(receiptText, 20) };

type Overrides = Partial<Omit<ParseReceiptDeps, 'anthropic'>> & { upstream?: MockStream | { status: number } | { throws: true } };

function setup(overrides: Overrides = {}) {
  const { upstream = goodStream, ...depOverrides } = overrides;
  const mock = mockAnthropicFetch(upstream);
  const calls: string[] = [];
  const stored: { billId: string; bytes: number; mediaType: string }[] = [];
  const deps: ParseReceiptDeps = {
    authenticate: async () => ({ userId: 'user-1', isAnonymous: false }),
    hasAiConsent: async () => true,
    checkLimits: async () => {
      calls.push('checkLimits');
      return 'ok';
    },
    createDraftBill: async () => {
      calls.push('createDraftBill');
      return 'bill-1';
    },
    storeReceiptImage: async (billId, image, mediaType) => {
      calls.push('storeReceiptImage');
      stored.push({ billId, bytes: image.byteLength, mediaType });
    },
    discardDraftBill: async (billId) => {
      calls.push(`discardDraftBill:${billId}`);
    },
    recordSuccessfulScan: async (userId) => {
      calls.push(`recordSuccessfulScan:${userId}`);
    },
    anthropic: { apiKey: 'sk-ant-test-key', model: 'test-model', fetch: mock.fetch },
    maxImageBytes: 1000,
    ...depOverrides,
  };
  return { deps, calls, stored, upstream: mock };
}

const photo = (bytes = 100, contentType = 'image/jpeg') =>
  new Request('http://localhost/functions/v1/parse-receipt', {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: 'Bearer token' },
    body: new Uint8Array(bytes).fill(7),
  });

const readEvents = async (response: Response): Promise<WireEvent[]> => {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

describe('handleParseReceipt: success', () => {
  it('streams an item event per line item, then done with the bill id and receipt, as NDJSON', async () => {
    const { deps } = setup();
    const response = await handleParseReceipt(photo(), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(NDJSON_CONTENT_TYPE);
    expect(await readEvents(response)).toEqual([
      { type: 'item', ...sampleReceipt.items[0] },
      { type: 'item', ...sampleReceipt.items[1] },
      { type: 'done', billId: 'bill-1', receipt: sampleReceipt },
    ]);
  });

  it('reports the model token usage through onScanUsage on success only', async () => {
    const usages: unknown[] = [];
    const ok = setup({ upstream: { ...goodStream, usage: { inputTokens: 1234, outputTokens: 56 } }, onScanUsage: (u) => usages.push(u) });
    await (await handleParseReceipt(photo(), ok.deps)).text();
    expect(usages).toEqual([{ inputTokens: 1234, outputTokens: 56 }]);

    const failed = setup({ upstream: { status: 500 }, onScanUsage: (u) => usages.push(u) });
    await (await handleParseReceipt(photo(), failed.deps)).text();
    expect(usages).toHaveLength(1);
  });

  it('delivers items to the client before the model has finished', async () => {
    const { deps } = setup();
    const response = await handleParseReceipt(photo(), deps);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const decoded = new TextDecoder().decode(first.value);
    expect(JSON.parse(decoded)).toMatchObject({ type: 'item', name: 'Draft Beer' });
    await reader.cancel();
  });

  it('writes one JSON object per line and nothing else', async () => {
    const { deps } = setup();
    const text = await (await handleParseReceipt(photo(), deps)).text();
    expect(text.endsWith('\n')).toBe(true);
    for (const l of text.trimEnd().split('\n')) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('creates the draft, stores the photo, and counts a quota use once, on success', async () => {
    const { deps, calls, stored } = setup();
    await (await handleParseReceipt(photo(120, 'image/png'), deps)).text();
    expect(stored).toEqual([{ billId: 'bill-1', bytes: 120, mediaType: 'image/png' }]);
    expect(calls).toEqual(['checkLimits', 'createDraftBill', 'storeReceiptImage', 'recordSuccessfulScan:user-1']);
  });

  it('sends the photo and the ANTHROPIC_MODEL to the model, and never returns the key', async () => {
    const { deps, upstream } = setup();
    const text = await (await handleParseReceipt(photo(), deps)).text();
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body.model).toBe('test-model');
    expect(text).not.toContain('sk-ant-test-key');
  });

  it('accepts a content type with parameters, in any case', async () => {
    const { deps } = setup();
    const response = await handleParseReceipt(photo(50, 'Image/JPEG; charset=binary'), deps);
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe('handleParseReceipt: rejected before the model is called', () => {
  const expectRejected = async (response: Response, status: number, code: string, upstream: { requests: unknown[] }) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe(NDJSON_CONTENT_TYPE);
    expect(await readEvents(response)).toEqual([{ type: 'error', code }]);
    expect(upstream.requests).toHaveLength(0);
  };

  it('UNAUTHORIZED without a valid session', async () => {
    const { deps, upstream, calls } = setup({ authenticate: async () => null });
    await expectRejected(await handleParseReceipt(photo(), deps), 401, 'UNAUTHORIZED', upstream);
    expect(calls).toEqual([]);
  });

  it('UNAUTHORIZED for an anonymous guest session', async () => {
    const { deps, upstream } = setup({ authenticate: async () => ({ userId: 'guest', isAnonymous: true }) });
    await expectRejected(await handleParseReceipt(photo(), deps), 401, 'UNAUTHORIZED', upstream);
  });

  it('CONSENT_REQUIRED without a recorded AI consent, before any limit is charged', async () => {
    const { deps, upstream, calls } = setup({ hasAiConsent: async () => false });
    await expectRejected(await handleParseReceipt(photo(), deps), 403, 'CONSENT_REQUIRED', upstream);
    expect(calls).toEqual([]);
  });

  it('RATE_LIMITED when the hourly limit is hit', async () => {
    const { deps, upstream, calls } = setup({ checkLimits: async () => 'RATE_LIMITED' });
    await expectRejected(await handleParseReceipt(photo(), deps), 429, 'RATE_LIMITED', upstream);
    expect(calls).toEqual([]);
  });

  it('QUOTA_EXCEEDED when the free monthly quota is used up', async () => {
    const { deps, upstream } = setup({ checkLimits: async () => 'QUOTA_EXCEEDED' });
    await expectRejected(await handleParseReceipt(photo(), deps), 402, 'QUOTA_EXCEEDED', upstream);
  });

  it('TOO_LARGE when Content-Length is over the limit, without reading the body', async () => {
    const { deps, upstream, calls } = setup({ maxImageBytes: 50 });
    const request = photo(100);
    request.headers.set('content-length', '100');
    await expectRejected(await handleParseReceipt(request, deps), 413, 'TOO_LARGE', upstream);
    expect(calls).toEqual([]);
  });

  it('TOO_LARGE when the body is over the limit but Content-Length is missing or wrong', async () => {
    const { deps, upstream } = setup({ maxImageBytes: 50 });
    await expectRejected(await handleParseReceipt(photo(100), deps), 413, 'TOO_LARGE', upstream);
  });

  it('accepts a photo exactly at the limit', async () => {
    const { deps } = setup({ maxImageBytes: 100 });
    const response = await handleParseReceipt(photo(100), deps);
    expect(response.status).toBe(200);
    await response.text();
  });

  it('NOT_A_RECEIPT for an empty body or a non-image content type', async () => {
    const { deps, upstream } = setup();
    await expectRejected(await handleParseReceipt(photo(0), deps), 422, 'NOT_A_RECEIPT', upstream);
    await expectRejected(await handleParseReceipt(photo(10, 'application/pdf'), deps), 422, 'NOT_A_RECEIPT', upstream);
    await expectRejected(await handleParseReceipt(photo(10, 'text/plain'), deps), 422, 'NOT_A_RECEIPT', upstream);
  });

  it('answers 405 to anything but POST', async () => {
    const { deps } = setup();
    const response = await handleParseReceipt(new Request('http://localhost/', { method: 'GET' }), deps);
    expect(response.status).toBe(405);
  });
});

describe('handleParseReceipt: failures during the parse', () => {
  it('NOT_A_RECEIPT: error event, draft discarded, no quota use', async () => {
    const notReceipt = { ...sampleReceipt, isReceipt: false, items: [], fees: [], currency: '' };
    const { deps, calls } = setup({ upstream: { textChunks: [JSON.stringify(notReceipt)] } });
    const response = await handleParseReceipt(photo(), deps);
    expect(response.status).toBe(200);
    expect(await readEvents(response)).toEqual([{ type: 'error', code: 'NOT_A_RECEIPT' }]);
    expect(calls).toContain('discardDraftBill:bill-1');
    expect(calls.some((c) => c.startsWith('recordSuccessfulScan'))).toBe(false);
  });

  it('UPSTREAM_ERROR when the model API fails: draft discarded, no quota use', async () => {
    const { deps, calls } = setup({ upstream: { status: 529 } });
    const events = await readEvents(await handleParseReceipt(photo(), deps));
    expect(events).toEqual([{ type: 'error', code: 'UPSTREAM_ERROR' }]);
    expect(calls).toContain('discardDraftBill:bill-1');
    expect(calls.some((c) => c.startsWith('recordSuccessfulScan'))).toBe(false);
  });

  it('INVALID_OUTPUT when the model breaks the schema, after any good items already streamed', async () => {
    const bad = { ...sampleReceipt, taxCents: -5 };
    const { deps, calls } = setup({ upstream: { textChunks: chunkText(JSON.stringify(bad), 20) } });
    const events = await readEvents(await handleParseReceipt(photo(), deps));
    expect(events.map((e) => e.type)).toEqual(['item', 'item', 'error']);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'INVALID_OUTPUT' });
    expect(calls.some((c) => c.startsWith('recordSuccessfulScan'))).toBe(false);
  });

  it('UPSTREAM_ERROR, with no done event, when storing the photo fails', async () => {
    const { deps, calls } = setup({
      storeReceiptImage: async () => {
        throw new Error('storage down');
      },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const events = await readEvents(await handleParseReceipt(photo(), deps));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'UPSTREAM_ERROR' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(calls).toContain('discardDraftBill:bill-1');
    expect(calls.some((c) => c.startsWith('recordSuccessfulScan'))).toBe(false);
    errorSpy.mockRestore();
  });

  it('UPSTREAM_ERROR when the draft bill cannot be created', async () => {
    const { deps } = setup({
      createDraftBill: async () => {
        throw new Error('db down');
      },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const events = await readEvents(await handleParseReceipt(photo(), deps));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'UPSTREAM_ERROR' });
    errorSpy.mockRestore();
  });

  it('never logs the image or the key', async () => {
    const { deps } = setup({
      storeReceiptImage: async () => {
        throw new Error('storage down');
      },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await (await handleParseReceipt(photo(), deps)).text();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-ant-test-key');
    errorSpy.mockRestore();
  });
});

describe('handleParseReceipt: client disconnects', () => {
  it('cancels the model call when the app stops reading', async () => {
    let signal: AbortSignal | undefined;
    const { deps } = setup();
    const baseFetch = deps.anthropic.fetch!;
    deps.anthropic.fetch = ((url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return baseFetch(url, init);
    }) as typeof fetch;
    const response = await handleParseReceipt(photo(), deps);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('discards the draft and records no quota use when the app disconnects mid-scan', async () => {
    const { deps, calls } = setup();
    const response = await handleParseReceipt(photo(), deps);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(calls).toContain('discardDraftBill:bill-1');
    expect(calls.some((c) => c.startsWith('recordSuccessfulScan'))).toBe(false);
  });

  it('keeps the draft when the app disconnects after the scan completed', async () => {
    const { deps, calls } = setup();
    const response = await handleParseReceipt(photo(), deps);
    const reader = response.body!.getReader();
    for (let i = 0; i < 3; i++) await reader.read();
    await reader.cancel();
    expect(calls).toContain('recordSuccessfulScan:user-1');
    expect(calls.some((c) => c.startsWith('discardDraftBill'))).toBe(false);
  });
});
