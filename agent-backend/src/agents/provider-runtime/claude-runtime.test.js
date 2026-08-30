// Claude AgentRuntime adapter contract (STH-7).
//
// Drives the production Claude adapter (provider-runtime/claude-runtime.js)
// over a scripted SDK stream and asserts the AgentRuntime contract on its
// OUTPUT — the provider-neutral event vocabulary, streaming order, tool
// call/result matching, canonical continuation, cancellation, normalized
// provider failures, and exactly-one-terminal — plus the tool adapter's
// MCP/Zod projection. The real zod compiler runs; only the SDK is scripted.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const state = {
    stream: () => (async function* () {})(),
    interrupt: null,
    queries: [],
  };
  state.interrupt = vi.fn();
  return {
    __state: state,
    query: vi.fn((opts) => {
      state.queries.push(opts);
      const gen = state.stream(opts);
      gen.interrupt = state.interrupt;
      return gen;
    }),
    tool: vi.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
    createSdkMcpServer: vi.fn((opts) => ({ __mcp: opts })),
  };
});

import { __state as sdkState, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeRuntime, CLAUDE_PROVIDER } from './claude-runtime.js';
import { buildClaudeToolSet, CLAUDE_MCP_SERVER_NAME } from './claude-tools.js';
import { validateRuntimeEventSequence } from './contract.js';
import { validateContinuation } from './continuation.js';
import { WEB_SEARCH_TOOL } from '../tools/registry.js';

let calls;
const kuhnTool = () => ({
  name: 'write_file',
  description: 'Write a file',
  grants: ['file_write'],
  readOnly: false,
  effect: 'write',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async (id, args) => {
    calls.push({ id, ...args });
    return { content: [{ type: 'text', text: `Saved ${args.path}` }] };
  },
});

function makeRuntime(tools = [kuhnTool()]) {
  return createClaudeRuntime({
    model: 'claude-test-1',
    projectDir: '/tmp/kuhn-test-project',
    tools,
    maxTurns: 50,
    initialSessionId: null,
  });
}

async function drain(runtime, turn) {
  const events = [];
  for await (const e of runtime.runTurn(turn)) events.push(e);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  sdkState.queries = [];
  sdkState.interrupt = vi.fn();
  sdkState.stream = () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's-default' };
    yield { type: 'result', subtype: 'success', usage: {} };
  })();
});

describe('identity and streaming (STH-7)', () => {
  it('emits the provider identity first, then deltas before the full turn', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 10, output_tokens: 5 } } };
      yield { type: 'result', subtype: 'success', session_id: 's-1', usage: { input_tokens: 100, output_tokens: 50 } };
    })();

    const events = await drain(makeRuntime(), { input: 'hi' });

    // Identity first (no session yet), then the session id once the provider
    // allocates one from the init message.
    expect(events[0]).toMatchObject({ type: 'provider', provider: CLAUDE_PROVIDER, model: 'claude-test-1' });
    expect(events.find((e) => e.type === 'provider' && e.sessionId)).toMatchObject({ sessionId: 's-1' });
    const deltas = events.filter((e) => e.type === 'text_delta');
    const text = events.find((e) => e.type === 'text');
    expect(deltas.map((d) => d.content)).toEqual(['Hel', 'lo']);
    expect(text.content).toBe('Hello');
    expect(events.indexOf(deltas[0])).toBeLessThan(events.indexOf(text));
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('passes the model, cwd, max turns, and resume session to the SDK', async () => {
    const rt = createClaudeRuntime({
      model: 'claude-test-1', projectDir: '/tmp/p', tools: [kuhnTool()], maxTurns: 7, initialSessionId: 'resume-me',
    });
    await drain(rt, { input: 'hi', resume: 'resume-me', systemPrompt: 'SP' });
    const opts = sdkState.queries.at(-1).options;
    expect(opts).toMatchObject({ cwd: '/tmp/p', model: 'claude-test-1', maxTurns: 7, resume: 'resume-me', systemPrompt: 'SP' });
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.mcpServers[CLAUDE_MCP_SERVER_NAME]).toBeDefined();
  });
});

describe('tool call / result lifecycle (STH-7)', () => {
  it('matches each tool_result to its tool_call and runs the executor once', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Writing' },
            { type: 'tool_use', id: 't1', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, input: { path: 'draft.md', content: 'x' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Saved draft.md' }] } };
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } };
    })();

    const events = await drain(makeRuntime(), { input: 'write it' });

    const call = events.find((e) => e.type === 'tool_call');
    const result = events.find((e) => e.type === 'tool_result');
    // The events carry the name Claude reports (the MCP-qualified name);
    // the neutral mapping is the adapter's toolNames/allowedTools surface.
    expect(call).toMatchObject({ id: 't1', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, arguments: { path: 'draft.md', content: 'x' } });
    expect(events.indexOf(call)).toBeLessThan(events.indexOf(result));
    expect(result).toMatchObject({ id: 't1', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, isError: false });
    expect(result.content).toEqual([{ type: 'text', text: 'Saved draft.md' }]);
    // The MCP handler (what the real SDK invokes) executes the neutral tool
    // and forwards its envelope verbatim.
    const set = buildClaudeToolSet([kuhnTool()]);
    const out = await set.mcpServer.__mcp.tools[0].handler({ path: 'a.md', content: 'z' }, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'claude-write_file', path: 'a.md', content: 'z' });
    expect(out).toEqual({ content: [{ type: 'text', text: 'Saved a.md' }] });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('marks errored tool results and keeps them model-visible', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't9', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, input: { path: 'x.md', content: 'x' } }] },
      };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'disk full', is_error: true }] } };
      yield { type: 'result', subtype: 'success', usage: {} };
    })();

    const events = await drain(makeRuntime(), { input: 'go' });
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ id: 't9', isError: true });
    expect(result.content[0].text).toBe('disk full');
  });
});

describe('canonical continuation (STH-7)', () => {
  it('done carries a canonical, balanced continuation and cumulative usage', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Working' },
            { type: 'tool_use', id: 't1', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, input: { path: 'a.md', content: '1' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } };
    })();

    const events = await drain(makeRuntime(), { input: 'start' });
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(validateContinuation(done.continuation)).toEqual([]);
    expect(done.continuation.version).toBe(1);
    // The transcript opens with the turn input and stays balanced: the
    // assistant tool_call is followed by its tool_result.
    const messages = done.continuation.messages;
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'start' }] });
    const roles = messages.map((m) => m.role);
    const callIndex = messages.findIndex((m) => m.role === 'assistant');
    expect(roles[callIndex + 1]).toBe('tool_result');
    // Usage is canonical (disjoint components), from the result message.
    expect(done.usage).toEqual({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 150,
    });
  });

  it('closes a dangling tool call with an explicit error marker', async () => {
    // A malformed stream: the assistant requested a tool, then the stream
    // ended without the tool_result and without a result message.
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't2', name: `mcp__${CLAUDE_MCP_SERVER_NAME}__write_file`, input: { path: 'a.md', content: '1' } }] },
      };
    })();

    const events = await drain(makeRuntime(), { input: 'start' });
    const terminal = events.at(-1);
    expect(terminal.type).toBe('error');
    expect(terminal.continuation).not.toBeNull();
    expect(validateContinuation(terminal.continuation)).toEqual([]);
    const last = terminal.continuation.messages.at(-1);
    expect(last).toMatchObject({ role: 'tool_result', toolCallId: 't2', isError: true });
    expect(last.content[0].text).toMatch(/unresolved/);
  });
});

describe('cancellation (STH-7)', () => {
  it('interrupts the SDK query and ends with exactly one cancelled terminal', async () => {
    // The gate resolves when interrupt() fires — set up before the stream so
    // an interrupt landing before the stream reaches the gate still closes
    // it (as a real interrupt ends the query).
    let releaseFn;
    const gate = new Promise((r) => { releaseFn = r; });
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-x' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 3, output_tokens: 2 } } };
      await gate;
    })();
    sdkState.interrupt = vi.fn(() => releaseFn());

    const rt = makeRuntime();
    const ac = new AbortController();
    const events = [];
    const runPromise = (async () => {
      for await (const e of rt.runTurn({ input: 'hi', signal: ac.signal })) {
        events.push(e);
        // Simulate the product layer cutting the turn off mid-stream (the
        // budget path), which interrupts the in-flight query.
        if (e.type === 'usage') ac.abort();
      }
    })();
    await runPromise;
    // Let the abort listener's interrupt microtask run.
    await new Promise((r) => setTimeout(r, 0));

    expect(sdkState.interrupt).toHaveBeenCalled();
    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'error' });
    expect(terminals[0].error.code).toBe('cancelled');
    // The terminal carries the cumulative usage and the partial canonical
    // continuation (the in-flight assistant text is preserved).
    expect(terminals[0].usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(terminals[0].continuation).not.toBeNull();
    expect(validateContinuation(terminals[0].continuation)).toEqual([]);
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });
});

describe('normalized provider failures (STH-7)', () => {
  it('maps thrown upstream failures to normalized retryable codes', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      throw Object.assign(new Error('API Error: 429 rate limit exceeded'), { status: 429 });
    })();
    const events = await drain(makeRuntime(), { input: 'hi' });
    const terminal = events.at(-1);
    expect(terminal.type).toBe('error');
    expect(terminal.error).toMatchObject({ code: 'rate_limit', retryable: true, status: 429 });
    expect(validateRuntimeEventSequence(events)).toEqual([]);
  });

  it('maps a 529 overload to the overloaded code', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      throw Object.assign(new Error('Overloaded'), { status: 529 });
    })();
    const events = await drain(makeRuntime(), { input: 'hi' });
    expect(events.at(-1).error).toMatchObject({ code: 'overloaded', retryable: true, status: 529 });
  });

  it('maps SDK result subtypes to non-retryable turn terminations', async () => {
    sdkState.stream = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 5, output_tokens: 5 } };
    })();
    const events = await drain(makeRuntime(), { input: 'hi' });
    const terminal = events.at(-1);
    expect(terminal.type).toBe('error');
    expect(terminal.error).toMatchObject({ code: 'max_turns', retryable: false });
    expect(terminal.error.message).toBe('max turns');
    expect(terminal.usage).toMatchObject({ inputTokens: 5, outputTokens: 5 });
  });
});

describe('exactly one terminal (STH-7)', () => {
  const scenarios = [
    ['success', () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      yield { type: 'result', subtype: 'success', usage: {} };
    })()],
    ['thrown network error', () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    })()],
    ['stream end without result', () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' };
    })()],
  ];

  for (const [label, stream] of scenarios) {
    it(`${label} ends with exactly one terminal event`, async () => {
      sdkState.stream = stream;
      const events = await drain(makeRuntime(), { input: 'hi' });
      const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
      expect(terminals).toHaveLength(1);
      expect(events.at(-1)).toBe(terminals[0]);
      expect(validateRuntimeEventSequence(events)).toEqual([]);
    });
  }
});

describe('Claude tool adapter projection (STH-1)', () => {
  it('projects neutral tools into MCP names and the allowlist', () => {
    const set = buildClaudeToolSet([kuhnTool(), WEB_SEARCH_TOOL]);
    expect(set.toolNames).toEqual(['write_file']);
    expect(set.builtinTools).toEqual(['WebSearch', 'WebFetch']);
    expect(set.allowedTools).toEqual(['WebSearch', 'WebFetch', 'mcp__kuhn__write_file']);
    expect(set.mcpServer.__mcp.name).toBe('kuhn');
    // The MCP server registers the NEUTRAL name; the SDK exposes it to the
    // model as `mcp__<server>__<name>` (see allowedTools above).

    expect(set.mcpServer.__mcp.tools[0].name).toBe('write_file');
    // The Zod shape compiles (the SDK tool() recorded the compiled schema).
    expect(set.mcpServer.__mcp.tools[0].schema).toBeDefined();
  });

  it('omits the MCP server when the role holds no Kuhn-executed tools', () => {
    const set = buildClaudeToolSet([WEB_SEARCH_TOOL]);
    expect(set.mcpServer).toBeNull();
    expect(set.allowedTools).toEqual(['WebSearch', 'WebFetch']);
  });
});
