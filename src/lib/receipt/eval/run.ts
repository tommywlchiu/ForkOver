/**
 * Runs fixtures through the parse-receipt handler (`handleParseReceipt`, the
 * same code the Edge Function serves) and scores what comes back. Only the
 * consent, limit, draft, and storage ports are stand-ins.
 */
import type { Usage } from '../anthropic.ts';
import { handleParseReceipt, type ParseReceiptDeps, type WireEvent } from '../handler.ts';
import type { ParsedReceipt } from '../schema.ts';
import { createEvalPorts } from './ports.ts';
import { scoreReceipt } from './score.ts';
import { scanCostMicroUsd } from './summary.ts';
import type { EvalFixture, ScanResult } from './types.ts';

export type EvalOptions = {
  /** Secret. Handed to the Anthropic client and nowhere else. */
  apiKey: string;
  /** Same default as the Edge Function's MAX_IMAGE_BYTES. */
  maxImageBytes: number;
  /** Lets stub mode answer instead of the real API. Omit to call Anthropic. */
  fetchFor?: (fixture: EvalFixture, model: string) => typeof fetch;
  timeoutMs?: number;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
};

export const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

/** Reads the handler's newline-delimited JSON body, calling `onEvent` as each line arrives. */
async function readEvents(response: Response, onEvent: (event: WireEvent) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (text: string) => {
    if (text.trim()) onEvent(JSON.parse(text) as WireEvent);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(flush);
  }
  flush(buffer + decoder.decode());
}

export async function runScan(fixture: EvalFixture, model: string, options: EvalOptions): Promise<ScanResult> {
  const now = options.now ?? (() => performance.now());
  const outcome: {
    errorCode: string | null;
    receipt: ParsedReceipt | null;
    firstItemMs: number | null;
    doneMs: number | null;
    usage: Usage | null;
  } = { errorCode: 'NO_RESULT', receipt: null, firstItemMs: null, doneMs: null, usage: null };
  const deps: ParseReceiptDeps = {
    ...createEvalPorts(),
    anthropic: {
      apiKey: options.apiKey,
      model,
      fetch: options.fetchFor?.(fixture, model),
      timeoutMs: options.timeoutMs,
    },
    onScanUsage: (u) => {
      outcome.usage = u;
    },
    maxImageBytes: options.maxImageBytes,
  };

  const request = new Request('http://eval.local/parse-receipt', {
    method: 'POST',
    headers: { 'content-type': fixture.mediaType, authorization: 'Bearer eval' },
    body: fixture.image as BodyInit,
  });
  const started = now();
  try {
    const response = await handleParseReceipt(request, deps);
    await readEvents(response, (event) => {
      if (event.type === 'item') {
        outcome.firstItemMs ??= now() - started;
      } else if (event.type === 'done') {
        outcome.doneMs = now() - started;
        outcome.receipt = event.receipt;
        outcome.errorCode = null;
      } else {
        outcome.errorCode = event.code;
      }
    });
  } catch {
    // Deliberately no message: an exception from a client library must not be able to echo the key.
    outcome.errorCode = 'EVAL_EXCEPTION';
  }

  return {
    fixture: fixture.name,
    model,
    errorCode: outcome.errorCode,
    receipt: outcome.receipt,
    score: outcome.receipt ? scoreReceipt(outcome.receipt, fixture.expected) : null,
    firstItemMs: outcome.firstItemMs,
    doneMs: outcome.doneMs,
    usage: outcome.usage,
    costMicroUsd: outcome.usage ? scanCostMicroUsd(model, outcome.usage) : null,
  };
}

/** Every fixture through every model, one scan at a time so latencies are not skewed by each other. */
export async function runEval(
  fixtures: readonly EvalFixture[],
  models: readonly string[],
  options: EvalOptions,
  onResult?: (result: ScanResult) => void,
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const model of models) {
    for (const fixture of fixtures) {
      const result = await runScan(fixture, model, options);
      results.push(result);
      onResult?.(result);
    }
  }
  return results;
}
