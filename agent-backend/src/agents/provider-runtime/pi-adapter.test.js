import { describe, expect, it, vi } from 'vitest';
import {
  Type,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

import { addUsage, normalizeUsage, validateRuntimeEventSequence } from './contract.js';
import { createContinuation, validateContinuation } from './continuation.js';
import {
  PiAgentRuntime,
  createFauxPiRuntime,
  createOpenAICompatiblePiRuntime,
  createOpenAIPiRuntime,
} from './pi-adapter.js';
import { ScriptedRuntime } from './scripted-runtime.js';

async function collect(iterable, onEvent) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Deterministic provider whose scripted steps control the raw stream events
 * (deltas, usage, terminal error) — for the cases the faux provider cannot
 * express: missing/partial usage and a provider failure after partial text.
 * Each step is `step(stamped, stream) => finalMessage` and must return the
 * message the stream ends with.
 */
function createScriptedPiProvider({ provider = 'kuhn-scripted', modelId = 'scripted-1', steps = [] } = {}) {
  const api = 'scripted';
  const model = {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: 'http://localhost:0',
    reasoning: false,
    input: ['text'],
    cost: { ...ZERO_COST },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const stamped = (fields) => ({
    role: 'assistant',
    content: [],
    api,
    provider,
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
    ...fields,
  });
  const scripted = createProvider({
    id: provider,
    auth: { apiKey: { name: 'Scripted', resolve: async () => ({ auth: {} }) } },
    models: [model],
    // createProvider treats an api object as a single API implementation only
    // when it exposes a `stream` function; both entry points share one body.
    api: {
      stream: scriptedStream,
      streamSimple: scriptedStream,
    },
  });
  function scriptedStream() {
    const stream = createAssistantMessageEventStream();
    const step = steps.length > 0
      ? steps.shift()
      : () => stamped({ stopReason: 'error', errorMessage: 'No more scripted responses' });
    queueMicrotask(() => {
      const finalMessage = step(stamped, stream);
      if (finalMessage.stopReason === 'error' || finalMessage.stopReason === 'aborted') {
        stream.push({ type: 'error', reason: finalMessage.stopReason, error: finalMessage });
      } else {
        stream.push({ type: 'done', reason: finalMessage.stopReason, message: finalMessage });
      }
      stream.end(finalMessage);
    });
    return stream;
  }
  const collection = createModels();
  collection.setProvider(scripted);
  return { collection, model };
}

/** Stream text deltas for `text`, then end the stream in a provider error. */
function partialTextThenError(stamped, stream, { text, errorMessage }) {
  const partial = stamped({ content: [{ type: 'text', text: '' }], stopReason: 'pending' });
  stream.push({ type: 'start', partial: { ...partial } });
  const half = Math.ceil(text.length / 2);
  let accumulated = '';
  for (const delta of [text.slice(0, half), text.slice(half)]) {
    if (!delta) continue;
    accumulated += delta;
    partial.content[0].text = accumulated;
    stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: { ...partial } });
  }
  return stamped({ content: [{ type: 'text', text }], stopReason: 'error', errorMessage });
}

/** Stream one text delta, then end with `done` carrying the given usage shape. */
function doneWithUsage(stamped, stream, { text = 'Usage check.', usage }) {
  const partial = stamped({ content: [{ type: 'text', text: '' }], stopReason: 'pending' });
  stream.push({ type: 'start', partial: { ...partial } });
  const done = stamped({ content: [{ type: 'text', text }], stopReason: 'stop' });
  stream.push({
    type: 'text_delta',
    contentIndex: 0,
    delta: text,
    partial: stamped({ content: [{ type: 'text', text }], stopReason: 'pending' }),
  });
  if (usage === undefined) {
    delete done.usage;
  } else {
    done.usage = usage;
  }
  return done;
}

describe('Pi production adapter', () => {
  it('normalizes text streaming, provider identity, usage, and terminal state', async () => {
    const { runtime, faux } = createFauxPiRuntime({
      responses: [fauxAssistantMessage('Hello from Pi.')],
    });

    const events = await collect(runtime.runTurn({ input: 'Hello' }));

    expect(events[0]).toMatchObject({
      type: 'provider', provider: 'kuhn-faux', model: 'faux-1', api: expect.stringMatching(/^faux:/),
    });
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.content).join(''))
      .toBe('Hello from Pi.');
    expect(events.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'Hello from Pi.' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
      continuation: { version: 1, messages: expect.any(Array) },
    });
    expect(faux.state.callCount).toBe(1);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('executes multi-round tool calls, validates arguments, and lets the model continue', async () => {
    const execute = vi.fn(async (_toolCallId, args) => ({
      content: [{ type: 'text', text: args.text.toUpperCase() }],
      details: { source: 'kuhn-tool' },
    }));
    const echoTool = {
      name: 'echo',
      label: 'Echo',
      description: 'Echo text through a Kuhn-owned tool',
      parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
      execute,
    };
    const { runtime } = createFauxPiRuntime({
      tools: [echoTool],
      responses: [
        fauxAssistantMessage([
          fauxText('First pass.'),
          fauxToolCall('echo', { text: 'one' }, { id: 'tool-1' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          const result = context.messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'tool-1');
          const call = fauxAssistantMessage([
            fauxText('Second pass.'),
            fauxToolCall('echo', { text: 'two' }, { id: 'tool-2' }),
          ], { stopReason: 'toolUse' });
          if (result?.content[0].text !== 'ONE') throw new Error('first tool result did not reach the model');
          return call;
        },
        (context) => {
          const second = context.messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'tool-2');
          return fauxAssistantMessage(`Both tools returned: ${second.content[0].text}.`);
        },
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Use echo twice' }));

    expect(execute).toHaveBeenNthCalledWith(1, 'tool-1', { text: 'one' }, expect.any(AbortSignal), expect.any(Function));
    expect(execute).toHaveBeenNthCalledWith(2, 'tool-2', { text: 'two' }, expect.any(AbortSignal), expect.any(Function));
    expect(events.filter((event) => event.type === 'tool_call').map((event) => event.id)).toEqual(['tool-1', 'tool-2']);
    expect(events.filter((event) => event.type === 'tool_result').map((event) => ({ id: event.id, isError: event.isError })))
      .toEqual([{ id: 'tool-1', isError: false }, { id: 'tool-2', isError: false }]);
    expect(events.filter((event) => event.type === 'tool_result').at(-1).content)
      .toEqual([{ type: 'text', text: 'TWO' }]);
    expect(events.filter((event) => event.type === 'text').map((event) => event.content))
      .toEqual(['First pass.', 'Second pass.', 'Both tools returned: TWO.']);
    // Every tool_call is followed by exactly one matching tool_result.
    const lifecycle = events
      .filter((event) => event.type === 'tool_call' || event.type === 'tool_result')
      .map((event) => `${event.type}:${event.id}`);
    expect(lifecycle).toEqual(['tool_call:tool-1', 'tool_result:tool-1', 'tool_call:tool-2', 'tool_result:tool-2']);
    // Usage accumulates across the provider calls of one turn.
    expect(events.at(-1).usage.totalTokens).toBeGreaterThan(0);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('reports the attempted tool_call, fails validation in tool_result, and never calls Kuhn code', async () => {
    const execute = vi.fn();
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'count',
        label: 'Count',
        description: 'Accept a number',
        parameters: Type.Object({ value: Type.Number() }),
        execute,
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('count', { value: 'not-a-number' }, { id: 'bad-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Recovered from the invalid call.'),
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Count' }));

    // tool_call means "the model attempted this call with these arguments";
    // the schema-validation outcome is the matching tool_result.
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      id: 'bad-1', name: 'count', arguments: { value: 'not-a-number' },
    });
    const callIndex = events.findIndex((event) => event.type === 'tool_call');
    const resultIndex = events.findIndex((event) => event.type === 'tool_result');
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBe(callIndex + 1);

    const result = events[resultIndex];
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'bad-1', name: 'count', isError: true });
    expect(result.content[0].text).toMatch(/validation failed/i);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('represents thrown Kuhn tool failures as error results and continues', async () => {
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'fail',
        label: 'Fail',
        description: 'Fail intentionally',
        parameters: Type.Object({}),
        execute: async () => { throw new Error('storage refused the write'); },
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('fail', {}, { id: 'fail-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('The tool failed safely.'),
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Try it' }));

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      id: 'fail-1', isError: true,
      content: [{ type: 'text', text: 'storage refused the write' }],
    });
    expect(events.at(-1).type).toBe('done');
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('fails calls to tools Kuhn did not pass without executing anything', async () => {
    const execute = vi.fn();
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'safe',
        description: 'The only tool Kuhn passed',
        parameters: Type.Object({}),
        execute,
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('read_file', { path: '/etc/passwd' }, { id: 'ghost-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Back to work.'),
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Peek' }));

    expect(execute).not.toHaveBeenCalled();
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ id: 'ghost-1', name: 'read_file', isError: true });
    expect(result.content[0].text).toMatch(/not found/i);
    expect(events.at(-1).type).toBe('done');
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('validates configuration and turn input', () => {
    expect(() => new PiAgentRuntime({ models: null, model: { provider: 'p', id: 'm' } }))
      .toThrow(/Models collection/);
    expect(() => new PiAgentRuntime({
      models: { streamSimple: () => {} },
      model: { provider: 'p' },
    })).toThrow(/explicit model/);
  });

  it('refuses an empty turn input without starting a provider request', async () => {
    const { runtime, faux } = createFauxPiRuntime({ responses: [fauxAssistantMessage('unused')] });
    await expect(collect(runtime.runTurn({ input: '' }))).rejects.toThrow(/non-empty string/);
    expect(faux.state.callCount).toBe(0);
  });

  it('continues across turns with portable transcript state', async () => {
    const { runtime } = createFauxPiRuntime({
      responses: [
        fauxAssistantMessage('First answer.'),
        (context) => {
          const prior = context.messages.some((message) => message.role === 'assistant'
            && message.content.some?.((block) => block.type === 'text' && block.text === 'First answer.'));
          return fauxAssistantMessage(prior ? 'I remember.' : 'I forgot.');
        },
      ],
    });

    const first = await collect(runtime.runTurn({ input: 'First question' }));
    const second = await collect(runtime.runTurn({
      input: 'Do you remember?',
      continuation: first.at(-1).continuation,
    }));

    expect(second.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'I remember.' });
    expect(second.at(-1).continuation.messages.length)
      .toBeGreaterThan(first.at(-1).continuation.messages.length);
    expect(second.at(-1).continuation).not.toHaveProperty('sessionId');
  });

  it('propagates AbortSignal cancellation to Pi and emits terminal cancelled error', async () => {
    const { runtime } = createFauxPiRuntime({
      tokensPerSecond: 20,
      responses: [fauxAssistantMessage('This response is deliberately long enough to cancel while streaming.')],
    });
    const controller = new AbortController();

    const events = await collect(runtime.runTurn({ input: 'Start', signal: controller.signal }), (event) => {
      if (event.type === 'text_delta') controller.abort();
    });

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled', retryable: false } });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('refuses a pre-aborted signal without starting provider work or tools', async () => {
    const execute = vi.fn();
    const { runtime, faux } = createFauxPiRuntime({
      responses: [fauxAssistantMessage('Should never stream.')],
      tools: [{
        name: 'never',
        label: 'Never',
        description: 'Must not run',
        parameters: Type.Object({}),
        execute,
      }],
    });
    const controller = new AbortController();
    controller.abort(new Error('caller gave up before the turn'));

    const events = await collect(runtime.runTurn({ input: 'Start', signal: controller.signal }));

    expect(events.map((event) => event.type)).toEqual(['provider', 'error']);
    expect(events[0]).toMatchObject({ type: 'provider', provider: 'kuhn-faux', model: 'faux-1' });
    expect(events.at(-1).error).toMatchObject({ code: 'cancelled', retryable: false });
    // callCount increments inside the faux stream function, so zero proves the
    // provider stream was never invoked.
    expect(faux.state.callCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('cancels a turn that arrives while a tool is about to execute', async () => {
    const execute = vi.fn();
    const { runtime, faux } = createFauxPiRuntime({
      tools: [{
        name: 'slow',
        label: 'Slow',
        description: 'A tool that should never start',
        parameters: Type.Object({}),
        execute,
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('slow', {}, { id: 'slow-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Should never stream.'),
      ],
    });
    const controller = new AbortController();

    const events = await collect(runtime.runTurn({ input: 'Start', signal: controller.signal }), (event) => {
      if (event.type === 'tool_call') controller.abort();
    });

    // The abort lands before execution starts: the tool never runs and the
    // call still gets exactly one error tool_result.
    expect(execute).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      id: 'slow-1', isError: true,
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled', retryable: false } });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(faux.state.callCount).toBe(1);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('cancels a turn while a tool is executing and reports the tool result', async () => {
    const controller = new AbortController();
    const { runtime, faux } = createFauxPiRuntime({
      tools: [{
        name: 'slow',
        label: 'Slow',
        description: 'A tool that aborts itself while in flight',
        parameters: Type.Object({}),
        // The tool aborts the caller's signal while executing, then finishes:
        // the deterministic "abort during a tool" window.
        execute: async (_toolCallId, _args, signal) => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 1));
          return {
            content: [{ type: 'text', text: 'tool finished after abort' }],
            details: { sawAbort: signal.aborted },
          };
        },
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('slow', {}, { id: 'slow-2' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Should never stream.'),
      ],
    });
    const events = await collect(runtime.runTurn({ input: 'Start', signal: controller.signal }));

    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({
      id: 'slow-2', isError: false,
      content: [{ type: 'text', text: 'tool finished after abort' }],
      details: { sawAbort: true },
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled', retryable: false } });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    // The aborted signal stopped the run before the model's second request.
    expect(faux.state.callCount).toBe(1);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it.each([
    ['429 rate limit exceeded', 'rate_limit', true],
    ['Service temporarily overloaded', 'overloaded', true],
    ["This model's maximum context length is 128000 tokens", 'context_overflow', false],
    ['Request timed out after 60000ms', 'timeout', true],
    ['fetch failed: ECONNREFUSED 127.0.0.1:9', 'network', true],
    ['Model exploded for an unknown reason', 'provider_error', false],
  ])('normalizes %s failures into a terminal %s error', async (errorMessage, code, retryable) => {
    const { runtime } = createFauxPiRuntime({
      responses: [fauxAssistantMessage([], { stopReason: 'error', errorMessage })],
    });

    const events = await collect(runtime.runTurn({ input: 'Start' }));

    expect(events[0].type).toBe('provider');
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code, retryable } });
    expect(events.filter((event) => ['done', 'text', 'text_delta'].includes(event.type))).toEqual([]);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('reports partial text before a mid-stream provider failure', async () => {
    const text = 'The answer started before the connection dropped.';
    const { collection, model } = createScriptedPiProvider({
      steps: [(stamped, stream) => partialTextThenError(stamped, stream, {
        text,
        errorMessage: 'socket hang up',
      })],
    });
    const runtime = new PiAgentRuntime({ models: collection, model });

    const events = await collect(runtime.runTurn({ input: 'Answer' }));

    const deltas = events.filter((event) => event.type === 'text_delta').map((event) => event.content).join('');
    expect(deltas).toBe(text);
    expect(events.find((event) => event.type === 'text')).toEqual({ type: 'text', content: text });
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'network', retryable: true } });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
    // The error terminal preserves the cumulative usage and the partial
    // canonical transcript so a retried attempt keeps the record complete.
    expect(events.at(-1).usage).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    });
    expect(events.at(-1).continuation.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Answer' }] },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ]);
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('reports missing usage without inventing zeros', async () => {
    const { collection, model } = createScriptedPiProvider({
      steps: [(stamped, stream) => doneWithUsage(stamped, stream, { usage: undefined })],
    });
    const runtime = new PiAgentRuntime({ models: collection, model });

    const events = await collect(runtime.runTurn({ input: 'Usage' }));

    expect(events.at(-1).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('reports partial usage and derives the total from known components', async () => {
    const { collection, model } = createScriptedPiProvider({
      steps: [(stamped, stream) => doneWithUsage(stamped, stream, { usage: { input: 7, output: 3 } })],
    });
    const runtime = new PiAgentRuntime({ models: collection, model });

    const events = await collect(runtime.runTurn({ input: 'Usage' }));

    expect(events.at(-1).usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 10,
    });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('accumulates usage across tool rounds inside one turn', async () => {
    const { collection, model } = createScriptedPiProvider({
      steps: [
        (stamped) => stamped({
          content: [{ type: 'toolCall', id: 'u-1', name: 'ack', arguments: {} }],
          usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...ZERO_COST, total: 0 } },
          stopReason: 'toolUse',
        }),
        (stamped, stream) => doneWithUsage(stamped, stream, {
          text: 'Usage round two.',
          usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { ...ZERO_COST, total: 0 } },
        }),
      ],
    });
    const runtime = new PiAgentRuntime({
      models: collection,
      model,
      tools: [{
        name: 'ack',
        description: 'Acknowledge',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'acknowledged' }] }),
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Usage' }));

    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ id: 'u-1', isError: false });
    expect(events.at(-1).usage).toEqual({
      inputTokens: 2,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7,
    });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('streams reasoning blocks without leaking them into text or continuation', async () => {
    let capturedReasoning;
    const { runtime, model } = createFauxPiRuntime({
      models: [{ id: 'reason-1', name: 'Reasoning Model', reasoning: true, input: ['text'] }],
      modelId: 'reason-1',
      responses: [(_context, streamOptions) => {
        capturedReasoning = streamOptions.reasoning;
        return fauxAssistantMessage([
          fauxThinking('Let me work through it step by step.'),
          fauxText('Reasoned answer.'),
        ]);
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Think' }));

    // Reasoning models default to a medium thinking level...
    expect(model.reasoning).toBe(true);
    expect(runtime.identity.capabilities.reasoning).toBe(true);
    expect(events[0].capabilities.reasoning).toBe(true);
    expect(capturedReasoning).toBe('medium');
    // ...and an explicit level wins.
    const { runtime: tuned, faux: tunedFaux } = createFauxPiRuntime({
      models: [{ id: 'reason-2', name: 'Reasoning Model', reasoning: true, input: ['text'] }],
      modelId: 'reason-2',
      thinkingLevel: 'low',
      responses: [fauxAssistantMessage('Tuned.')],
    });
    let tunedReasoning;
    tunedFaux.setResponses([(_context, streamOptions) => {
      tunedReasoning = streamOptions.reasoning;
      return fauxAssistantMessage('Tuned.');
    }]);
    const tunedEvents = await collect(tuned.runTurn({ input: 'Think' }));
    expect(tunedReasoning).toBe('low');
    expect(tunedEvents.at(-1).type).toBe('done');

    // Thinking content never reaches text events, deltas, or continuation.
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.content).join(''))
      .toBe('Reasoned answer.');
    expect(events.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'Reasoned answer.' });
    const continuation = events.at(-1).continuation;
    expect(validateContinuation(continuation)).toEqual([]);
    expect(JSON.stringify(continuation)).not.toMatch(/thinking|work through it/i);
    expect(continuation.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Reasoned answer.' }],
    });
  });

  it('reports non-reasoning models without a thinking level', async () => {
    let capturedReasoning = 'unset';
    const { runtime, model } = createFauxPiRuntime({
      responses: [(context, streamOptions) => {
        capturedReasoning = streamOptions.reasoning;
        return fauxAssistantMessage('Plain answer.');
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Answer' }));

    expect(model.reasoning).toBe(false);
    expect(runtime.identity.capabilities.reasoning).toBe(false);
    expect(events[0].capabilities.reasoning).toBe(false);
    // thinkingLevel 'off' is not forwarded as a reasoning level.
    expect(capturedReasoning).toBeUndefined();
    expect(events.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'Plain answer.' });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('builds a configurable OpenAI-compatible model path with endpoint metadata', () => {
    const { model, provider, runtime } = createOpenAICompatiblePiRuntime({
      baseUrl: 'http://127.0.0.1:8000/v1/',
      providerId: 'local-vllm',
      modelId: 'qwen-science',
      apiKeyEnv: 'KUHN_TEST_VLLM_KEY',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
      },
    });

    expect(model).toMatchObject({
      provider: 'local-vllm', id: 'qwen-science', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
    expect(model.compat).toMatchObject({ supportsUsageInStreaming: false });
    expect(provider.getModels()).toEqual([model]);
    // Normalized identity exposes the configured endpoint (trailing slash
    // stripped) and model capabilities.
    expect(runtime.identity).toMatchObject({
      provider: 'local-vllm',
      model: 'qwen-science',
      api: 'openai-completions',
      endpoint: 'http://127.0.0.1:8000/v1',
      capabilities: { reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
    });
  });

  it('configures a real non-Anthropic OpenAI provider/model path without making a request', () => {
    const { model, provider, runtime } = createOpenAIPiRuntime({ modelId: 'gpt-5-mini' });

    expect(provider.id).toBe('openai');
    expect(model).toMatchObject({ provider: 'openai', id: 'gpt-5-mini' });
    expect(runtime.model).toBe(model);
    expect(runtime.identity).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it.each([
    ['https://user:pass@example.com/v1', /must not contain credentials/],
    ['file:///tmp/socket', /must use http or https/],
    ['not a url', /absolute http\(s\) URL/],
  ])('rejects unsafe custom endpoint %s', (baseUrl, message) => {
    expect(() => createOpenAICompatiblePiRuntime({ baseUrl, modelId: 'm' })).toThrow(message);
  });
});

describe('Pi adapter server-mode safety', () => {
  it('sends Kuhn system instructions verbatim and exposes exactly Kuhn tools', async () => {
    const sentinel = 'SENTINEL: Kuhn scientific-writing system instructions. No other context may be injected.';
    const captured = {};
    const { runtime } = createFauxPiRuntime({
      systemPrompt: sentinel,
      tools: [{
        name: 'echo',
        description: 'Echo text',
        parameters: Type.Object({ text: Type.String() }),
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }],
      responses: [(context) => {
        captured.systemPrompt = context.systemPrompt;
        captured.tools = context.tools.map((tool) => ({ name: tool.name, label: tool.label }));
        return fauxAssistantMessage('ok');
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Hello' }));

    // The model saw exactly Kuhn's instructions — no AGENTS.md/CLAUDE.md or
    // other implicit Pi context was merged in.
    expect(captured.systemPrompt).toBe(sentinel);
    // The model saw exactly the tools Kuhn passed — no Pi coding-agent
    // tools (read/write/edit/bash), no skills, nothing else.
    expect(captured.tools).toEqual([{ name: 'echo', label: 'echo' }]);
    expect(events.at(-1).type).toBe('done');
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('fails a turn with a normalized error when no credential is configured', async () => {
    const keyEnv = 'KUHN_S8_UNSET_KEY_MUST_NOT_EXIST';
    const saved = process.env[keyEnv];
    delete process.env[keyEnv];
    try {
      const { runtime } = createOpenAICompatiblePiRuntime({
        baseUrl: 'http://127.0.0.1:9/v1',
        providerId: 'no-auth',
        modelId: 'm',
        apiKeyEnv: keyEnv,
      });

      const events = await collect(runtime.runTurn({ input: 'Hi' }));

      // No ambient credential was borrowed: the turn terminates with a
      // normalized provider error naming the unconfigured provider.
      expect(events[0].type).toBe('provider');
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider_error', retryable: false } });
      expect(events.at(-1).error.message).toMatch(/not configured/i);
      expect(events.filter((event) => ['text', 'text_delta'].includes(event.type))).toEqual([]);
      expect(validateRuntimeEventSequence(events)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env[keyEnv];
      else process.env[keyEnv] = saved;
    }
  });

  it('runs two independent concurrent adapters without cross-talk', async () => {
    const left = createFauxPiRuntime({
      responses: [(context) => {
        const input = context.messages.at(-1).content.map((block) => block.text).join('');
        return fauxAssistantMessage(`Left says: ${input}`);
      }],
    });
    const right = createFauxPiRuntime({
      tools: [{
        name: 'echo',
        description: 'Echo text',
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, args) => ({ content: [{ type: 'text', text: args.text.toUpperCase() }] }),
      }],
      responses: [
        fauxAssistantMessage([fauxToolCall('echo', { text: 'right-payload' }, { id: 'right-1' })], { stopReason: 'toolUse' }),
        (context) => {
          const result = context.messages.find((message) => message.role === 'toolResult');
          return fauxAssistantMessage(`Right says: ${result.content[0].text}`);
        },
      ],
    });

    const [leftEvents, rightEvents] = await Promise.all([
      collect(left.runtime.runTurn({ input: 'one' })),
      collect(right.runtime.runTurn({ input: 'two' })),
    ]);

    expect(leftEvents.find((event) => event.type === 'text').content).toBe('Left says: one');
    expect(rightEvents.find((event) => event.type === 'tool_call')).toMatchObject({ id: 'right-1', name: 'echo' });
    expect(rightEvents.find((event) => event.type === 'text').content).toBe('Right says: RIGHT-PAYLOAD');
    // Continuations are per-instance and never mix.
    expect(leftEvents.at(-1).continuation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(rightEvents.at(-1).continuation.messages.map((message) => message.role))
      .toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(validateRuntimeEventSequence(leftEvents)).toEqual([]);
    expect(validateRuntimeEventSequence(rightEvents)).toEqual([]);
  });

  it('rejects a concurrent turn on one instance (one active turn per instance)', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const execute = vi.fn(async (_id, args) => {
      await firstGate;
      return { content: [{ type: 'text', text: args.text.toUpperCase() }] };
    });
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'slow',
        label: 'Slow',
        description: 'Slow echo',
        parameters: Type.Object({ text: Type.String() }),
        execute,
      }],
      responses: [
        fauxAssistantMessage([fauxToolCall('slow', { text: 'one' }, { id: 'slow-1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('First done.'),
      ],
    });

    const first = collect(runtime.runTurn({ input: 'first' }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    // One active turn per instance (STH-47): the concurrent call is refused
    // loudly instead of sharing the in-flight turn's state.
    const second = await collect(runtime.runTurn({ input: 'second' }));

    releaseFirst();
    const firstEvents = await first;

    expect(second[0]).toMatchObject({ type: 'provider' });
    expect(second).toHaveLength(2);
    expect(second[1]).toMatchObject({
      type: 'error',
      error: { code: 'invalid_request', retryable: false },
    });
    expect(validateRuntimeEventSequence(second)).toEqual([]);
    // The in-flight turn completes normally, unaffected.
    expect(firstEvents.find((event) => event.type === 'text').content).toBe('First done.');
    expect(validateRuntimeEventSequence(firstEvents)).toEqual([]);
  });

  it('stops at the product max-turn limit with the normalized max_turns error', async () => {
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'echo',
        label: 'Echo',
        description: 'Echo text',
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, args) => ({ content: [{ type: 'text', text: args.text.toUpperCase() }] }),
      }],
      maxTurns: 1,
      responses: [
        // Turn 1 ends with a tool call; without the limit the loop would
        // start a second assistant turn.
        fauxAssistantMessage([fauxToolCall('echo', { text: 'loop' }, { id: 'loop-1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Second turn that must not run.'),
      ],
    });
    const events = await collect(runtime.runTurn({ input: 'loop' }));

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: 'error',
      error: { code: 'max_turns', retryable: false },
    });
    // The record is structurally closed: the executed tool result is in it,
    // so a retry can resume from the tool result.
    expect(validateContinuation(terminal.continuation)).toEqual([]);
    expect(terminal.continuation.messages.at(-1))
      .toMatchObject({ role: 'tool_result', toolCallId: 'loop-1', isError: false });
  });

  it('lets a turn finish naturally at the max-turn boundary with no pending tool call', async () => {
    const { runtime } = createFauxPiRuntime({
      maxTurns: 2,
      responses: [
        fauxAssistantMessage([fauxToolCall('noop', { text: 'x' }, { id: 'n-1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Finished within the limit.'),
      ],
      tools: [{
        name: 'noop',
        label: 'Noop',
        description: 'No-op',
        parameters: Type.Object({ text: Type.String() }),
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }],
    });
    const events = await collect(runtime.runTurn({ input: 'go' }));
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });
});

describe('canonical continuation across Pi instances', () => {
  const echoTool = (execute) => ({
    name: 'echo',
    label: 'Echo',
    description: 'Echo text',
    parameters: Type.Object({ text: Type.String() }),
    execute,
  });

  async function runToolTurn() {
    const { runtime } = createFauxPiRuntime({
      tools: [echoTool(async (_id, args) => ({ content: [{ type: 'text', text: args.text.toUpperCase() }] }))],
      responses: [
        fauxAssistantMessage([
          fauxText('Calling echo.'),
          fauxToolCall('echo', { text: 'safe' }, { id: 'tool-1' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Echo done.'),
      ],
    });
    const events = await collect(runtime.runTurn({ input: 'Use echo' }));
    return events.at(-1).continuation;
  }

  it('emits only documented Kuhn fields with no Pi metadata leakage', async () => {
    const continuation = await runToolTurn();

    expect(validateContinuation(continuation)).toEqual([]);
    expect(Object.keys(continuation).sort()).toEqual(['messages', 'version']);

    const forbidden = new Set([
      'api', 'provider', 'model', 'usage', 'stopReason', 'timestamp',
      'responseId', 'responseModel', 'errorMessage', 'thinkingSignature', 'cost',
    ]);
    const seen = new Set();
    JSON.stringify(continuation, (key, value) => {
      seen.add(key);
      return value;
    });
    expect([...seen].filter((key) => forbidden.has(key))).toEqual([]);

    // Structured, not stringly: tool call and result survive as canonical state.
    expect(continuation.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Use echo' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling echo.' },
          { type: 'tool_call', id: 'tool-1', name: 'echo', arguments: { text: 'safe' } },
        ],
      },
      { role: 'tool_result', toolCallId: 'tool-1', toolName: 'echo', content: [{ type: 'text', text: 'SAFE' }], isError: false },
      { role: 'assistant', content: [{ type: 'text', text: 'Echo done.' }] },
    ]);
  });

  it('resumes in a fresh Pi instance from JSON-serialized canonical state', async () => {
    const continuation = await runToolTurn();
    const revived = JSON.parse(JSON.stringify(continuation));

    const second = createFauxPiRuntime({
      tools: [echoTool(async () => ({ content: [{ type: 'text', text: 'unused' }] }))],
      responses: [(context) => {
        const sawToolResult = context.messages.some((message) => message.role === 'toolResult'
          && message.toolName === 'echo'
          && message.content.some((block) => block.type === 'text' && block.text === 'SAFE'));
        const sawAssistantText = context.messages.some((message) => message.role === 'assistant'
          && message.content.some?.((block) => block.type === 'text' && block.text === 'Echo done.'));
        return fauxAssistantMessage(sawToolResult && sawAssistantText ? 'State restored.' : 'State lost.');
      }],
    });

    const events = await collect(second.runtime.runTurn({ input: 'What happened?', continuation: revived }));

    expect(events.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'State restored.' });
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('produces state a different runtime implementation can consume', async () => {
    const continuation = await runToolTurn();
    const scripted = new ScriptedRuntime({
      turns: [{ events: [{ type: 'text', content: 'Continuing elsewhere.' }] }],
    });

    const events = await collect(scripted.runTurn({ input: 'Carry on', continuation }));

    expect(scripted.requests[0].continuation).toEqual(continuation.messages);
    expect(events.at(-1).continuation.messages).toEqual([
      ...continuation.messages,
      { role: 'user', content: [{ type: 'text', text: 'Carry on' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Continuing elsewhere.' }] },
    ]);
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('rejects unknown continuation versions and non-canonical messages', async () => {
    const { runtime } = createFauxPiRuntime({ responses: [fauxAssistantMessage('unused')] });

    await expect(collect(runtime.runTurn({ input: 'Hi', continuation: { version: 99, messages: [] } })))
      .rejects.toThrow(/unsupported continuation version 99/);
    await expect(collect(runtime.runTurn({
      input: 'Hi',
      continuation: { version: 1, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: {} }] },
    }))).rejects.toThrow(/non-canonical field "usage"/);
    expect(() => createFauxPiRuntime({ continuation: { version: 99, messages: [] } }))
      .toThrow(/unsupported continuation version 99/);
  });

  it("retry: the failed attempt's user input is never re-appended (exactly once in the record)", async () => {
    const { runtime } = createFauxPiRuntime({
      responses: [fauxAssistantMessage('Recovering.')],
    });
    // The failed attempt's canonical record: the user input plus a partial
    // assistant message left by the interruption.
    const failedRecord = createContinuation([
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Partial ou' }] },
    ]);

    const events = await collect(runtime.runTurn({
      input: 'Do the thing',
      continuation: failedRecord,
      retry: true,
    }));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const texts = events.at(-1).continuation.messages
      .flatMap((m) => m.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text);
    // One logical user request: the input appears exactly once; the partial
    // assistant from the failed attempt is dropped on the retried attempt.
    expect(texts.filter((t) => t === 'Do the thing')).toHaveLength(1);
    expect(texts).not.toContain('Partial ou');
    expect(texts).toContain('Recovering.');
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('retry: a record that ended with a tool result resumes from that tool result', async () => {
    const { runtime } = createFauxPiRuntime({
      responses: [fauxAssistantMessage('Continuing after the tool.')],
    });
    const record = createContinuation([
      { role: 'user', content: [{ type: 'text', text: 'Use echo' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling.' },
          { type: 'tool_call', id: 'c-1', name: 'echo', arguments: { text: 'x' } },
        ],
      },
      { role: 'tool_result', toolCallId: 'c-1', toolName: 'echo', content: [{ type: 'text', text: 'X' }], isError: false },
    ]);

    const events = await collect(runtime.runTurn({
      input: 'Use echo',
      continuation: record,
      retry: true,
    }));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const roles = events.at(-1).continuation.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('follow-up (no retry flag): the new input is appended once on the record', async () => {
    const { runtime } = createFauxPiRuntime({
      responses: [fauxAssistantMessage('Follow-up answer.')],
    });
    const record = createContinuation([
      { role: 'user', content: [{ type: 'text', text: 'First question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
    ]);

    const events = await collect(runtime.runTurn({ input: 'Second question', continuation: record }));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.at(-1).continuation.messages.map((m) => m.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(validateContinuation(events.at(-1).continuation)).toEqual([]);
  });

  it('normalizes model arguments with the neutral Kuhn validator before execution', async () => {
    const execute = vi.fn(async (_id, args) => ({ content: [{ type: 'text', text: `got ${args.text}` }] }));
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'greet',
        label: 'Greet',
        description: 'Greet someone',
        parameters: Type.Object({
          text: Type.String(),
          loud: Type.Optional(Type.Boolean({ default: false })),
        }),
        execute,
      }],
      responses: [
        fauxAssistantMessage([fauxToolCall('greet', { text: 'hi' }, { id: 'g-1' })], { stopReason: 'toolUse' }),
        (context) => {
          const result = context.messages.find((m) => m.role === 'toolResult');
          return fauxAssistantMessage(`Result: ${result.content[0].text}`);
        },
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Greet' }));

    // The handler sees the neutral-normalized arguments (default applied),
    // not the raw model arguments.
    expect(execute).toHaveBeenCalledWith('g-1', { text: 'hi', loud: false }, expect.any(AbortSignal), expect.any(Function));
    expect(events.find((event) => event.type === 'text' && event.content === 'Result: got hi')).toBeDefined();
  });
});
describe('Pi adapter STH-1/STH-7 contract conformance', () => {
  it('cancel() interrupts the in-flight turn with a terminal cancelled error', async () => {
    let resolveTool;
    const gate = new Promise((resolve) => { resolveTool = resolve; });
    const { runtime, faux } = createFauxPiRuntime({
      tools: [{
        name: 'slow',
        description: 'A gated tool',
        parameters: Type.Object({}),
        execute: () => gate.then(() => ({ content: [{ type: 'text', text: 'late' }] })),
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('slow', {}, { id: 'slow-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('After the tool.'),
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Start' }), (event) => {
      if (event.type === 'tool_call') runtime.cancel();
    });
    resolveTool();

    const terminal = events.at(-1);
    // No AbortSignal was passed: the interruption came from runtime.cancel(),
    // the product teardown/budget-cutoff path.
    // Pi records the aborted tool attempt as an error result ("Operation
    // aborted"); whatever the record shape, the call never succeeded.
    for (const result of events.filter((event) => event.type === 'tool_result')) {
      expect(result.isError).toBe(true);
    }
    expect(terminal).toMatchObject({ type: 'error', error: { code: 'cancelled', retryable: false } });
    // The interrupted turn still preserves the transcript so far.
    expect(terminal.continuation).toMatchObject({ version: 1 });
    expect(faux.state.callCount).toBe(1);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('honors per-turn systemPrompt and resume (session identity)', async () => {
    const captures = [];
    const { runtime } = createFauxPiRuntime({
      systemPrompt: 'CONSTRUCTOR PROMPT',
      responses: [
        (context, streamOptions) => {
          captures.push({ prompt: context.systemPrompt, sessionId: streamOptions?.sessionId });
          return fauxAssistantMessage('First.');
        },
        (context, streamOptions) => {
          captures.push({ prompt: context.systemPrompt, sessionId: streamOptions?.sessionId });
          return fauxAssistantMessage('Second.');
        },
      ],
    });

    const first = await collect(runtime.runTurn({ input: 'One', resume: 'sess-1', systemPrompt: 'TURN PROMPT' }));
    expect(first[0]).toMatchObject({ type: 'provider', sessionId: 'sess-1' });
    expect(captures[0]).toEqual({ prompt: 'TURN PROMPT', sessionId: 'sess-1' });
    expect(first.at(-1)).toMatchObject({ type: 'done' });

    const second = await collect(runtime.runTurn({ input: 'Two' }));
    expect(second[0].sessionId).toBeUndefined();
    expect(captures[1]).toEqual({ prompt: 'CONSTRUCTOR PROMPT', sessionId: undefined });
    expect(validateRuntimeEventSequence(first)).toEqual([]);
    expect(validateRuntimeEventSequence(second)).toEqual([]);
  });

  it('omits provider_builtin and execute-less tools from the model surface', async () => {
    const captured = {};
    const { runtime } = createFauxPiRuntime({
      tools: [
        {
          name: 'echo',
          description: 'Echo text',
          parameters: Type.Object({ text: Type.String() }),
          execute: async (toolCallId, args) => ({ content: [{ type: 'text', text: args.text }] }),
        },
        // Provider-native capability Pi cannot supply (e.g. Claude's
        // WebSearch/WebFetch): the descriptor rides along for adapters that
        // can map it, and must be omitted here.
        {
          name: 'web_search',
          description: 'Native web search',
          kind: 'provider_builtin',
          execute: null,
          parameters: Type.Object({ query: Type.String() }),
        },
        { name: 'ghost', description: 'No executor', parameters: Type.Object({}) },
      ],
      responses: [(context) => {
        captured.tools = context.tools.map((tool) => tool.name);
        return fauxAssistantMessage('ok');
      }],
    });

    const events = await collect(runtime.runTurn({ input: 'Hi' }));
    expect(captured.tools).toEqual(['echo']);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('turns a Kuhn tool failure envelope into an error tool result', async () => {
    const seen = [];
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'boom',
        description: 'Fails inside the envelope, never throws',
        parameters: Type.Object({}),
        execute: () => ({ content: [{ type: 'text', text: 'disk on fire' }], isError: true }),
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('boom', {}, { id: 'boom-1' }), { stopReason: 'toolUse' }),
        (context) => {
          seen.push(context.messages.filter((message) => message.role === 'toolResult').map((message) => message.content));
          return fauxAssistantMessage('Recovering.');
        },
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Do it' }));
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ id: 'boom-1', name: 'boom', isError: true });
    expect(result.content).toEqual([{ type: 'text', text: 'disk on fire' }]);
    // The model-facing tool result carries the failure text: Pi derives
    // isError from a throw, so the adapter translates the envelope into a
    // throw carrying the model-facing text.
    expect(seen[0][0].some((block) => block.text.includes('disk on fire'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('emits canonical per-message usage events and cumulative terminal usage', async () => {
    const { runtime } = createFauxPiRuntime({
      tools: [{
        name: 'echo',
        description: 'Echo text',
        parameters: Type.Object({ text: Type.String() }),
        execute: async (toolCallId, args) => ({ content: [{ type: 'text', text: args.text }] }),
      }],
      responses: [
        fauxAssistantMessage(fauxToolCall('echo', { text: 'round one' }, { id: 'echo-1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Two.'),
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Hi' }));
    const usageEvents = events.filter((event) => event.type === 'usage');
    expect(usageEvents).toHaveLength(2);
    for (const event of usageEvents) {
      expect(Object.keys(event.usage).sort()).toEqual([
        'cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'totalTokens',
      ].sort());
    }
    const sum = usageEvents.reduce((acc, event) => addUsage(acc, event.usage), normalizeUsage());
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: sum });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });
});
