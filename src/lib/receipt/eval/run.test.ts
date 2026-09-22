import { chunkText, mockAnthropicFetch, type MockStream } from '../mockAnthropic';
import { sampleReceipt } from '../fixtures';
import { createEvalPorts } from './ports';
import { runEval, runScan, type EvalOptions } from './run';
import { builtinStubFixtures, receiptFromExpected, stubFetchFor } from './stub';
import type { EvalFixture } from './types';

const [usd, jpy] = builtinStubFixtures();
const options = (over: Partial<EvalOptions> = {}): EvalOptions => ({
  apiKey: 'sk-ant-secret-test-key',
  maxImageBytes: 1_000_000,
  fetchFor: stubFetchFor,
  ...over,
});

const upstream = (stream: MockStream | { status: number } | { throws: true }) => () => mockAnthropicFetch(stream).fetch;

describe('runScan through the handler', () => {
  it('reads the fixture back, scores it, and reports usage and cost', async () => {
    const result = await runScan(usd, 'claude-sonnet-5', options());
    expect(result).toMatchObject({ fixture: 'stub-usd', model: 'claude-sonnet-5', errorCode: null });
    expect(result.receipt).toEqual(receiptFromExpected(usd.expected));
    expect(result.score?.allMatch).toBe(true);
    expect(result.usage?.inputTokens).toBe(1500);
    // 1500 in at $2/MTok plus the output tokens at $10/MTok
    expect(result.costMicroUsd).toBe(1500 * 2 + (result.usage?.outputTokens ?? 0) * 10);
  });

  it('times the first item and done from the injected clock', async () => {
    let t = 0;
    const result = await runScan(usd, 'claude-sonnet-5', options({ now: () => (t += 100) }));
    // every read of the clock advances it, so later events are stamped later
    expect(result.firstItemMs).toBeGreaterThan(0);
    expect(result.doneMs).toBeGreaterThan(result.firstItemMs ?? Infinity);
  });

  it('scores a wrong read as a miss, not a failure', async () => {
    const wrong = { ...receiptFromExpected(usd.expected), taxCents: 1 };
    const result = await runScan(usd, 'm', options({ fetchFor: upstream({ textChunks: chunkText(JSON.stringify(wrong), 30) }) }));
    expect(result.errorCode).toBeNull();
    expect(result.score).toMatchObject({ taxMatch: false, allMatch: false, itemsMatch: true });
  });

  it('records an upstream failure with no score, usage, or done time', async () => {
    const result = await runScan(usd, 'm', options({ fetchFor: upstream({ status: 500 }) }));
    expect(result).toMatchObject({ errorCode: 'UPSTREAM_ERROR', receipt: null, score: null, doneMs: null, usage: null, costMicroUsd: null });
  });

  it('records invalid model output', async () => {
    const result = await runScan(usd, 'm', options({ fetchFor: upstream({ textChunks: ['{"nope":'] }) }));
    expect(result.errorCode).toBe('INVALID_OUTPUT');
  });

  it('records a non-receipt answer', async () => {
    const notReceipt = { ...receiptFromExpected(usd.expected), isReceipt: false, items: [] };
    const result = await runScan(usd, 'm', options({ fetchFor: upstream({ textChunks: [JSON.stringify(notReceipt)] }) }));
    expect(result.errorCode).toBe('NOT_A_RECEIPT');
  });

  it('reports a photo over the size limit as TOO_LARGE without calling the model', async () => {
    const mock = mockAnthropicFetch({ textChunks: [] });
    const result = await runScan(usd, 'm', options({ maxImageBytes: 5, fetchFor: () => mock.fetch }));
    expect(result.errorCode).toBe('TOO_LARGE');
    expect(mock.requests).toHaveLength(0);
  });

  it('sends the photo and the model the caller named, with the key only in the request header', async () => {
    const mock = mockAnthropicFetch({ textChunks: chunkText(JSON.stringify(sampleReceipt), 30) });
    const result = await runScan(jpy, 'claude-haiku-4-5-20251001', options({ fetchFor: () => mock.fetch }));
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body.model).toBe('claude-haiku-4-5-20251001');
    expect(mock.requests[0].body.messages[0].content[0].source.media_type).toBe('image/png');
    expect(mock.requests[0].headers['x-api-key']).toBe('sk-ant-secret-test-key');
    expect(JSON.stringify(result)).not.toContain('sk-ant-secret-test-key');
  });
});

describe('runEval', () => {
  it('runs every fixture through every model, model by model, and reports each result', async () => {
    const seen: string[] = [];
    const results = await runEval([usd, jpy], ['a', 'b'], options(), (r) => seen.push(`${r.model}/${r.fixture}`));
    expect(seen).toEqual(['a/stub-usd', 'a/stub-jpy', 'b/stub-usd', 'b/stub-jpy']);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.score?.allMatch)).toBe(true);
  });

  it('uses the in-memory ports only: consent and limits pass, storage is recorded', async () => {
    const ports = createEvalPorts();
    expect(await ports.hasAiConsent('u')).toBe(true);
    expect(await ports.checkLimits('u')).toBe('ok');
    expect(await ports.createDraftBill('u')).toBe('eval-bill-1');
    await ports.storeReceiptImage('eval-bill-1', new Uint8Array(1), 'image/jpeg');
    await ports.discardDraftBill('eval-bill-1');
    expect(ports.log).toEqual(['createDraftBill', 'storeReceiptImage:eval-bill-1', 'discardDraftBill:eval-bill-1']);
  });
});

describe('stub fixtures', () => {
  it('are well-formed fixtures that need no files', () => {
    const fixtures: EvalFixture[] = builtinStubFixtures();
    expect(fixtures.map((f) => f.name)).toEqual(['stub-usd', 'stub-jpy']);
    expect(fixtures.every((f) => f.image.byteLength > 0)).toBe(true);
  });
});
