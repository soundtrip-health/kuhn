import { describe, expect, it } from 'vitest';

import {
  normalizeProviderError,
  normalizeUsage,
  validateRuntimeEventSequence,
} from './contract.js';
import { ScriptedRuntime } from './scripted-runtime.js';

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('provider-neutral runtime contract', () => {
  it('freezes ordered deltas, final text, usage, continuation, and terminal done', async () => {
    const runtime = new ScriptedRuntime({
      provider: 'fake-openai-compatible',
      model: 'fake-model',
      turns: [{
        events: [
          { type: 'text_delta', content: 'Hel' },
          { type: 'text_delta', content: 'lo' },
          { type: 'text', content: 'Hello' },
        ],
        usage: { input: 7, output: 2 },
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Hi' }));

    expect(events.map((event) => event.type)).toEqual([
      'provider', 'text_delta', 'text_delta', 'text', 'done',
    ]);
    expect(events.at(-1)).toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 9,
      },
      continuation: {
        version: 1,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
        ],
      },
    });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('continues from portable messages rather than an opaque provider session id', async () => {
    const first = new ScriptedRuntime({
      turns: [{ events: [{ type: 'text_delta', content: 'One' }, { type: 'text', content: 'One' }] }],
    });
    const firstEvents = await collect(first.runTurn({ input: 'First' }));
    const continuation = firstEvents.at(-1).continuation;

    const second = new ScriptedRuntime({
      turns: [{ events: [{ type: 'text_delta', content: 'Two' }, { type: 'text', content: 'Two' }] }],
    });
    const secondEvents = await collect(second.runTurn({ input: 'Second', continuation }));

    expect(second.requests[0].continuation).toEqual(continuation.messages);
    expect(secondEvents.at(-1).continuation.messages).toEqual([
      ...continuation.messages,
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: 'Two' },
    ]);
  });

  it('ends cancellation with normalized error and no done event', async () => {
    const runtime = new ScriptedRuntime({ turns: [{ waitForAbort: true }] });
    const controller = new AbortController();
    const pending = collect(runtime.runTurn({ input: 'wait', signal: controller.signal }));
    controller.abort();
    const events = await pending;

    expect(events.map((event) => event.type)).toEqual(['provider', 'error']);
    expect(events.at(-1).error).toMatchObject({ code: 'cancelled', retryable: false });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it.each([
    [{ status: 429, message: 'Too many requests' }, 'rate_limit', true],
    [{ status: 529, message: 'Overloaded' }, 'overloaded', true],
    [{ status: 503, message: 'Unavailable' }, 'server', true],
    [{ code: 'ECONNRESET', message: 'socket reset' }, 'network', true],
    [{ status: 408, message: 'Request timed out' }, 'timeout', true],
    [{ message: 'maximum context length exceeded' }, 'context_overflow', false],
    [{ message: 'bad request' }, 'provider_error', false],
  ])('normalizes provider failure %o as %s', (error, code, retryable) => {
    expect(normalizeProviderError(error)).toMatchObject({ code, retryable });
  });

  it('keeps omitted usage explicit instead of inventing provider fields', () => {
    expect(normalizeUsage({ input: 0, output: 3 })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 3,
    });
    expect(normalizeUsage()).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    });
  });

  it('rejects an intentionally incomplete adapter transcript', () => {
    const violations = validateRuntimeEventSequence([
      { type: 'provider', provider: 'broken', model: 'broken-1' },
      { type: 'text_delta', content: 'partial' },
      { type: 'tool_call', id: 'orphan-1', name: 'missing_result', arguments: {} },
      { type: 'done', usage: {} },
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      'text deltas must conclude with a final text event',
      'tool_call orphan-1 has no tool_result',
      'done must include portable continuation messages',
    ]));
  });
});
