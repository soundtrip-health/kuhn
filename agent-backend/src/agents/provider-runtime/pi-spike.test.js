import { describe, expect, it, vi } from 'vitest';
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';

import { validateRuntimeEventSequence } from './contract.js';
import { validateContinuation } from './continuation.js';
import {
  createFauxPiRuntime,
  createOpenAICompatiblePiRuntime,
  createOpenAIPiRuntime,
} from './pi-spike.js';
import { ScriptedRuntime } from './scripted-runtime.js';

async function collect(iterable, onEvent) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe('Pi core/model runtime spike', () => {
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

  it('executes only supplied tools, validates arguments, returns results, and lets the model continue', async () => {
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
          fauxText('Checking.'),
          fauxToolCall('echo', { text: 'safe' }, { id: 'tool-1' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          const result = context.messages.find((message) => message.role === 'toolResult');
          return fauxAssistantMessage(`Tool returned ${result.content[0].text}.`);
        },
      ],
    });

    const events = await collect(runtime.runTurn({ input: 'Use echo' }));

    expect(execute).toHaveBeenCalledWith('tool-1', { text: 'safe' }, expect.any(AbortSignal), expect.any(Function));
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({
      id: 'tool-1', name: 'echo', arguments: { text: 'safe' },
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      id: 'tool-1', name: 'echo', isError: false,
      content: [{ type: 'text', text: 'SAFE' }],
    });
    expect(events.filter((event) => event.type === 'text').at(-1).content).toBe('Tool returned SAFE.');
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
  });

  it('continues across user turns with portable transcript state', async () => {
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
    const second = await collect(runtime.runTurn({ input: 'Do you remember?' }));

    expect(second.find((event) => event.type === 'text')).toEqual({ type: 'text', content: 'I remember.' });
    expect(second.at(-1).continuation.messages.length).toBeGreaterThan(first.at(-1).continuation.messages.length);
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

  it('normalizes provider errors independently of Pi message wording', async () => {
    const { runtime } = createFauxPiRuntime({
      responses: [fauxAssistantMessage([], { stopReason: 'error', errorMessage: '429 rate limit exceeded' })],
    });

    const events = await collect(runtime.runTurn({ input: 'Start' }));

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'rate_limit', retryable: true } });
  });

  it('builds a configurable OpenAI-compatible model path without credentials or network', () => {
    const { model, provider, runtime } = createOpenAICompatiblePiRuntime({
      baseUrl: 'http://127.0.0.1:8000/v1',
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
    expect(runtime.agent.state.tools).toEqual([]);
  });

  it('configures a real non-Anthropic OpenAI provider/model path without making a request', () => {
    const { model, provider, runtime } = createOpenAIPiRuntime({ modelId: 'gpt-5-mini' });

    expect(provider.id).toBe('openai');
    expect(model).toMatchObject({ provider: 'openai', id: 'gpt-5-mini' });
    expect(runtime.agent.state.model).toBe(model);
  });

  it.each([
    ['https://user:pass@example.com/v1', /must not contain credentials/],
    ['file:///tmp/socket', /must use http or https/],
    ['not a url', /absolute http\(s\) URL/],
  ])('rejects unsafe custom endpoint %s', (baseUrl, message) => {
    expect(() => createOpenAICompatiblePiRuntime({ baseUrl, modelId: 'm' })).toThrow(message);
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
});
