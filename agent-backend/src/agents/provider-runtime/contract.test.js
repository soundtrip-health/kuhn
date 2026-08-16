import { describe, expect, it } from 'vitest';

import {
  normalizeProviderError,
  normalizeUsage,
  validateRuntimeEventSequence,
} from './contract.js';
import {
  assertContinuation,
  createContinuation,
  validateContinuation,
} from './continuation.js';
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
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
        ],
      },
    });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('continues from canonical messages rather than an opaque provider session id', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'Second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Two' }] },
    ]);
  });

  it('adds non-streamed final text to continuation exactly once', async () => {
    const bare = new ScriptedRuntime({
      turns: [{ events: [{ type: 'text', content: 'hello' }] }],
    });
    const bareEvents = await collect(bare.runTurn({ input: 'Hi' }));
    expect(bareEvents.at(-1).continuation.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(validateRuntimeEventSequence(bareEvents)).toEqual([]);

    const streamed = new ScriptedRuntime({
      turns: [{
        events: [
          { type: 'text_delta', content: 'hel' },
          { type: 'text_delta', content: 'lo' },
          { type: 'text', content: 'hello' },
        ],
      }],
    });
    const streamedEvents = await collect(streamed.runTurn({ input: 'Hi' }));
    expect(streamedEvents.at(-1).continuation.messages).toEqual(bareEvents.at(-1).continuation.messages);
  });

  it('records tool calls and results in canonical continuation state', async () => {
    const runtime = new ScriptedRuntime({
      turns: [{
        events: [
          { type: 'tool_call', id: 'call-1', name: 'echo', arguments: { text: 'hi' } },
          { type: 'tool_result', id: 'call-1', name: 'echo', content: [{ type: 'text', text: 'HI' }], isError: false },
          { type: 'text', content: 'Echoed.' },
        ],
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Use echo' }));
    const continuation = events.at(-1).continuation;

    expect(continuation.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Use echo' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call-1', name: 'echo', arguments: { text: 'hi' } }] },
      { role: 'tool_result', toolCallId: 'call-1', toolName: 'echo', content: [{ type: 'text', text: 'HI' }], isError: false },
      { role: 'assistant', content: [{ type: 'text', text: 'Echoed.' }] },
    ]);
    expect(validateContinuation(continuation)).toEqual([]);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('emits identity plus one cancelled error for a pre-aborted signal without recording a request', async () => {
    const runtime = new ScriptedRuntime({
      turns: [{ events: [{ type: 'text', content: 'never' }] }],
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(runtime.runTurn({ input: 'late', signal: controller.signal }));

    expect(events.map((event) => event.type)).toEqual(['provider', 'error']);
    expect(events.at(-1).error).toMatchObject({ code: 'cancelled', retryable: false });
    expect(runtime.requests).toEqual([]);
    expect(runtime.turns).toHaveLength(1);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('rejects unknown continuation versions with a clear error', async () => {
    const runtime = new ScriptedRuntime({ turns: [{ events: [] }] });
    const bad = runtime.runTurn({ input: 'Hi', continuation: { version: 2, messages: [] } });
    await expect(collect(bad)).rejects.toThrow(/unsupported continuation version 2/);
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

  it('derives totalTokens 0 from explicitly known all-zero components', () => {
    expect(normalizeUsage({ input: 0, output: 0 })).toMatchObject({ totalTokens: 0 });
    expect(normalizeUsage({ cacheRead: 0 })).toMatchObject({
      inputTokens: null,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
  });

  it('prefers a provider-reported total over component derivation', () => {
    expect(normalizeUsage({ input: 5, output: 5, totalTokens: 12 })).toMatchObject({ totalTokens: 12 });
  });

  it('sums disjoint cache components into the derived total', () => {
    expect(normalizeUsage({ input: 10, output: 5, cacheRead: 80, cacheWrite: 20 }))
      .toMatchObject({ totalTokens: 115 });
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
      'done must include canonical continuation messages',
    ]));
  });

  it('rejects a done event whose continuation leaks provider message fields', () => {
    const violations = validateRuntimeEventSequence([
      { type: 'provider', provider: 'leaky', model: 'leaky-1' },
      { type: 'text', content: 'ok' },
      {
        type: 'done',
        usage: {},
        continuation: {
          version: 1,
          messages: [{
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            provider: 'leaky',
            model: 'leaky-1',
            usage: { input: 1 },
            stopReason: 'stop',
          }],
        },
      },
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      'done continuation is not canonical: messages[0] has non-canonical field "provider"',
      'done continuation is not canonical: messages[0] has non-canonical field "usage"',
    ]));
  });
});

describe('canonical continuation schema', () => {
  const canonical = () => ({
    version: 1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'echo', arguments: { text: 'x' } }] },
      { role: 'tool_result', toolCallId: 'c1', toolName: 'echo', content: [{ type: 'text', text: 'X' }], isError: false },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
  });

  it('accepts only the documented Kuhn fields', () => {
    expect(validateContinuation(canonical())).toEqual([]);
  });

  it('fails clearly on unknown or incompatible versions', () => {
    expect(validateContinuation({ version: 2, messages: [] }))
      .toEqual(['unsupported continuation version 2; expected 1']);
    expect(validateContinuation({ messages: [] }))
      .toEqual(['unsupported continuation version undefined; expected 1']);
    expect(() => assertContinuation({ version: 'one', messages: [] }))
      .toThrow(/unsupported continuation version "one"/);
  });

  it('rejects provider metadata, unknown roles and unknown block types', () => {
    const leaked = canonical();
    leaked.messages[0].timestamp = 123;
    leaked.messages[1].content.push({ type: 'thinking', thinking: 'secret' });
    leaked.messages.push({ role: 'toolResult', toolCallId: 'c1', toolName: 'echo', content: [], isError: false });

    expect(validateContinuation(leaked)).toEqual(expect.arrayContaining([
      'messages[0] has non-canonical field "timestamp"',
      'messages[1].content[1] has unsupported type "thinking"',
      'messages[4] has unknown role "toolResult"',
    ]));
  });

  it('requires tool results to answer a preceding assistant tool call exactly once', () => {
    const orphan = canonical();
    orphan.messages.splice(1, 1);
    expect(validateContinuation(orphan))
      .toContain('tool_result c1 has no preceding assistant tool_call');

    const doubled = canonical();
    doubled.messages.push(structuredClone(doubled.messages[2]));
    expect(validateContinuation(doubled)).toContain('tool_result c1 is duplicated');
  });

  it('round-trips through JSON serialization', () => {
    const continuation = createContinuation(canonical().messages);
    expect(JSON.parse(JSON.stringify(continuation))).toEqual(continuation);
  });

  it('refuses to create a continuation from non-canonical messages', () => {
    expect(() => createContinuation([{ role: 'assistant', content: [{ type: 'text', text: 'x' }], api: 'pi' }]))
      .toThrow(/refusing to emit non-canonical continuation/);
  });
});
