import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------

// sdkState.generator (when set) replaces the canned message playback — used
// to simulate the SDK executing a blocking tool call mid-stream.
const sdkState = { messages: [], generator: null, interrupt: vi.fn(async () => {}) };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    const iterator = sdkState.generator
      ? sdkState.generator()
      : (async function* () {
          for (const m of sdkState.messages) yield m;
        })();
    iterator.interrupt = sdkState.interrupt;
    return iterator;
  }),
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: vi.fn((cfg) => ({ type: 'sdk', name: cfg.name })),
}));

// Pin the agent config so tests don't depend on .env / defaults drifting
vi.mock('../config.js', () => ({
  config: {
    agent: {
      tokenBudget: 250000,
      maxDispatchDepth: 2,
      questionTimeoutMs: 15 * 60 * 1000,
      model: undefined,
      modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 },
    },
  },
}));

vi.mock('../storage.js', () => ({
  resolveProjectDir: vi.fn(async (projectId) => `/projects/${projectId}`),
  readProjectFile: vi.fn(async () => Buffer.from('file body')),
  writeProjectFile: vi.fn(async () => ({ created: true })),
  listProjectTree: vi.fn(async () => []),
  searchProjectFiles: vi.fn(async () => []),
}));
vi.mock('../db/agents.js', () => ({ getAgentWithTools: vi.fn() }));
vi.mock('../db/conversation.js', () => ({
  createConversation: vi.fn(async () => ({ id: 7 })),
  logMessage: vi.fn(async () => ({})),
}));
vi.mock('../db/jobs.js', () => ({
  createJob: vi.fn(async () => ({ id: 42 })),
  updateJob: vi.fn(async () => ({})),
}));
vi.mock('../db/projects.js', () => ({
  updateProjectConfig: vi.fn(async () => ({})),
}));

import { query as sdkQuery, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { writeProjectFile } from '../storage.js';
import { getAgentWithTools } from '../db/agents.js';
import { logMessage } from '../db/conversation.js';
import { updateJob } from '../db/jobs.js';
import { updateProjectConfig } from '../db/projects.js';
import { deliverReply, hasPendingQuestion } from './questions.js';
import { getRun } from './runs.js';
import { runAgentTask, reattach } from './runtime.js';

const RA_AGENT = {
  slug: 'ra',
  name: 'Research Assistant',
  system_prompt: 'You are the research assistant.',
  tools: ['file_read', 'pubmed_search'],
};

async function collect(task) {
  const events = [];
  for await (const ev of runAgentTask(task)) events.push(ev);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdkState.messages = [];
  sdkState.generator = null;
  getAgentWithTools.mockResolvedValue(RA_AGENT);
});

// --- Tests -------------------------------------------------------------------

describe('runAgentTask', () => {
  it('maps SDK messages to AgentEvents and finishes with done + usage', async () => {
    sdkState.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Drafting now.' },
            { type: 'tool_use', id: 't1', name: 'mcp__kuhn__write_file', input: { path: 'draft.md', content: 'x' } },
            { type: 'tool_use', id: 't2', name: 'mcp__kuhn__edit_file', input: { path: 'notes.md', old_string: 'a', new_string: 'b' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-1', usage: { input_tokens: 100, output_tokens: 50 } },
    ];

    const events = await collect({ role: 'research', projectId: 1, input: 'write the intro' });

    expect(events).toEqual([
      { type: 'text', agent: 'ra', content: 'Drafting now.' },
      { type: 'file_change', agent: 'ra', path: 'draft.md', kind: 'create' },
      { type: 'file_change', agent: 'ra', path: 'notes.md', kind: 'update' },
      {
        type: 'done',
        agent: 'ra',
        jobId: 42,
        sessionId: 'sess-1',
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]);

    // Job lifecycle: running with conversation -> session recorded -> done with usage
    expect(updateJob).toHaveBeenCalledWith(42, { status: 'running', conversationId: 7 });
    expect(updateJob).toHaveBeenCalledWith(42, { sessionId: 'sess-1' });
    expect(updateJob).toHaveBeenCalledWith(42, { status: 'done', inputTokens: 100, outputTokens: 50 });

    // Conversation logging: user input, assistant turn, tool result
    const roles = logMessage.mock.calls.map(([m]) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
  });

  it('confines the SDK to the role tool allowlist and project workspace', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'ra', projectId: 1, input: 'go' });

    const options = sdkQuery.mock.calls[0][0].options;
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('bypassPermissions');
    // No built-in file tools (story 018) — file access only via storage-backed MCP tools
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toContain('mcp__kuhn__read_file');
    expect(options.allowedTools).toContain('mcp__kuhn__search_files');
    expect(options.allowedTools).toContain('mcp__kuhn__pubmed_search');
    expect(options.allowedTools).not.toContain('mcp__kuhn__write_file');
    expect(options.allowedTools).not.toContain('mcp__kuhn__dispatch_agent');
    expect(options.systemPrompt).toContain('You are the research assistant.');
    expect(options.cwd).toContain('1');
  });

  it('routes agent file writes through the storage service', async () => {
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, slug: 'writer', tools: ['file_write'] });
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'writer', projectId: 7, input: 'go' });

    const { tools } = createSdkMcpServer.mock.calls[0][0];
    const writeTool = tools.find((t) => t.name === 'write_file');
    const result = await writeTool.handler({ path: 'draft/main.md', content: 'hello' });
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'draft/main.md', 'hello');
    expect(result.isError).toBeUndefined();
  });

  it('forwards token-level text deltas and enables partial messages', async () => {
    sdkState.messages = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } },
    ];

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.content)).toEqual(['Hel', 'lo']);
    expect(events.find((e) => e.type === 'text')).toMatchObject({ content: 'Hello' });
    expect(sdkQuery.mock.calls[0][0].options.includePartialMessages).toBe(true);
  });

  it('stops the task with an error event when the token budget is exceeded', async () => {
    sdkState.messages = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'huge turn' }],
          usage: { input_tokens: 400000, output_tokens: 1000 },
        },
      },
      // Should never be reached
      { type: 'result', subtype: 'success', usage: {} },
    ];

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });

    const error = events.find((e) => e.type === 'error');
    expect(error.message).toMatch(/token budget exceeded/i);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    expect(sdkState.interrupt).toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'error', error: 'token budget exceeded' }));
  });

  it('maps non-success results to error events and job status', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 5, output_tokens: 5 } },
    ];
    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('max turns') });
    expect(updateJob).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'error', error: 'max turns' }));
  });

  it('emits an error for unknown roles', async () => {
    getAgentWithTools.mockResolvedValue(null);
    const events = await collect({ role: 'nope', projectId: 1, input: 'go' });
    expect(events).toEqual([
      { type: 'error', agent: 'nope', jobId: undefined, message: 'Unknown agent role: nope' },
    ]);
  });

  it('runs each agent on its DB-configured model, falling back to the global default', async () => {
    // Per-agent model wins (story 021)
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, model: 'claude-haiku-4-5' });
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(sdkQuery.mock.calls[0][0].options.model).toBe('claude-haiku-4-5');

    // No per-agent model → global config fallback (undefined here → SDK default)
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, model: null });
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(sdkQuery.mock.calls[1][0].options.model).toBeUndefined();
  });

  it('exposes dispatch_agent only to roles with spawn_agent', async () => {
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, slug: 'writer', tools: ['file_write', 'spawn_agent'] });
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'writer', projectId: 1, input: 'go' });
    const options = sdkQuery.mock.calls[0][0].options;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toContain('mcp__kuhn__write_file');
    expect(options.allowedTools).toContain('mcp__kuhn__edit_file');
    expect(options.allowedTools).toContain('mcp__kuhn__dispatch_agent');
  });
});

// --- Story 020: model-cost-weighted budget accounting ------------------------

describe('weighted token budget (story 020)', () => {
  const turn = (inputTokens, outputTokens) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'turn' }], usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  });
  const success = { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };

  async function collectWithBudget(model, budget) {
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, model });
    sdkState.messages = [turn(3000, 1000), success];
    const events = [];
    for await (const ev of runAgentTask({ role: 'ra', projectId: 1, input: 'go' }, { budget })) {
      events.push(ev);
    }
    return events;
  }

  it('burns the budget slower for cheap models than for the root tier', async () => {
    // Opus-rooted budget (baseWeight 5): 4000 Haiku tokens count as 800
    const budget = { used: 0, limit: 1000, baseWeight: 5 };
    const events = await collectWithBudget('claude-haiku-4-5', budget);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(budget.used).toBeCloseTo(800);
  });

  it('counts root-tier tokens at full weight', async () => {
    const budget = { used: 0, limit: 1000, baseWeight: 5 };
    const events = await collectWithBudget('claude-opus-4-8', budget);
    expect(events.find((e) => e.type === 'error')?.message).toMatch(/token budget exceeded/i);
    expect(budget.used).toBeCloseTo(4000);
  });

  it('pins the base weight to the root agent model', async () => {
    // Haiku root: its own tokens count 1:1 even though haiku weighs 1
    const budget = { used: 0, limit: 5000 };
    await collectWithBudget('claude-haiku-4-5', budget);
    expect(budget.baseWeight).toBe(1);
    expect(budget.used).toBeCloseTo(4000);
  });
});

// --- Story 012: PM agent interview tools ------------------------------------

const PM_AGENT = {
  slug: 'pm',
  name: 'Project Manager',
  system_prompt: 'You are the PM.',
  tools: ['file_read', 'file_list', 'spawn_agent', 'ask_user', 'project_config'],
};

describe('PM agent tools (story 012)', () => {
  beforeEach(() => {
    getAgentWithTools.mockResolvedValue(PM_AGENT);
  });

  it('exposes ask_user and save_project_config to the pm role', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'pm', projectId: 1, input: 'go' });
    const options = sdkQuery.mock.calls[0][0].options;
    expect(options.allowedTools).toContain('mcp__kuhn__ask_user');
    expect(options.allowedTools).toContain('mcp__kuhn__save_project_config');
    expect(options.allowedTools).toContain('mcp__kuhn__dispatch_agent');
  });

  it('ask_user emits a question event and blocks until the reply is delivered', async () => {
    // Simulate the SDK executing the blocking ask_user tool mid-stream
    sdkState.generator = async function* () {
      const { tools } = createSdkMcpServer.mock.calls[0][0];
      const askUser = tools.find((t) => t.name === 'ask_user');
      const result = await askUser.handler({ question: 'What type of document?' });
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `Answer: ${result.content[0].text}` }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } };
    };

    const events = [];
    for await (const ev of runAgentTask({ role: 'pm', projectId: 1, input: 'start' })) {
      events.push(ev);
      if (ev.type === 'question') {
        // The reply route resolves the registry entry keyed by the job id
        expect(deliverReply(42, 'An NIH R01 grant')).toBe(true);
      }
    }

    expect(events.find((e) => e.type === 'question')).toEqual({
      type: 'question',
      agent: 'pm',
      jobId: 42,
      content: 'What type of document?',
    });
    expect(events.find((e) => e.type === 'text')).toMatchObject({ content: 'Answer: An NIH R01 grant' });
    expect(events.at(-1)).toMatchObject({ type: 'done', jobId: 42 });
  });

  it('emits question_expired and a defaults nudge when the question times out (story 020)', async () => {
    vi.useFakeTimers();
    try {
      sdkState.generator = async function* () {
        const { tools } = createSdkMcpServer.mock.calls[0][0];
        const askUser = tools.find((t) => t.name === 'ask_user');
        const result = await askUser.handler({ question: 'Anyone home?' });
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: result.content[0].text }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
      };

      const events = [];
      for await (const ev of runAgentTask({ role: 'pm', projectId: 1, input: 'start' })) {
        events.push(ev);
        // Nobody answers: run the clock past the question timeout
        if (ev.type === 'question') await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      }

      expect(events.find((e) => e.type === 'question_expired')).toEqual({
        type: 'question_expired',
        agent: 'pm',
        jobId: 42,
      });
      expect(events.find((e) => e.type === 'text')?.content).toMatch(/No reply received/);
      expect(events.at(-1)).toMatchObject({ type: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending question when the consumer stops early', async () => {
    sdkState.generator = async function* () {
      const { tools } = createSdkMcpServer.mock.calls[0][0];
      const askUser = tools.find((t) => t.name === 'ask_user');
      await askUser.handler({ question: 'Still there?' });
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
    };

    for await (const ev of runAgentTask({ role: 'pm', projectId: 1, input: 'start' })) {
      if (ev.type === 'question') break; // browser disconnected
    }

    expect(hasPendingQuestion(42)).toBe(false);
    expect(updateJob).toHaveBeenCalledWith(42, { status: 'cancelled' });
  });

  it('save_project_config updates the project record and writes project.json', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'pm', projectId: 5, input: 'go' });

    const { tools } = createSdkMcpServer.mock.calls[0][0];
    const save = tools.find((t) => t.name === 'save_project_config');
    const result = await save.handler({
      title: 'GLP-1 RWE Study',
      project_type: 'rwe-protocol',
      research_question: 'Does GLP-1 use reduce MACE in T2D?',
      deliverables: ['FDA RWE protocol'],
      timeline: 'Draft by 2026-08-01',
      source_materials: ['FDA RWE guidance 2023'],
    });

    expect(result.isError).toBeUndefined();
    expect(updateProjectConfig).toHaveBeenCalledWith(5, {
      name: 'GLP-1 RWE Study',
      projectType: 'rwe-protocol',
      config: expect.objectContaining({
        title: 'GLP-1 RWE Study',
        project_type: 'rwe-protocol',
        research_question: 'Does GLP-1 use reduce MACE in T2D?',
        deliverables: ['FDA RWE protocol'],
        timeline: 'Draft by 2026-08-01',
        source_materials: ['FDA RWE guidance 2023'],
      }),
    });
    expect(writeProjectFile).toHaveBeenCalledWith(5, 'project.json', expect.stringContaining('GLP-1 RWE Study'));
  });

  it('save_project_config surfaces failures as tool errors', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'pm', projectId: 5, input: 'go' });
    updateProjectConfig.mockRejectedValueOnce(new Error('db down'));

    const { tools } = createSdkMcpServer.mock.calls[0][0];
    const save = tools.find((t) => t.name === 'save_project_config');
    const result = await save.handler({
      title: 't',
      project_type: 'manuscript',
      research_question: 'q',
      deliverables: ['d'],
      timeline: 'now',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/db down/);
  });
});

// --- Story 027: survive a disconnect while parked on a question -------------

describe('ask_user reconnect (story 027)', () => {
  beforeEach(() => {
    getAgentWithTools.mockResolvedValue(PM_AGENT);
  });

  // SDK loop that parks in ask_user, then answers and finishes once unblocked.
  const askThenAnswer = () => async function* () {
    const { tools } = createSdkMcpServer.mock.calls[0][0];
    const askUser = tools.find((t) => t.name === 'ask_user');
    const result = await askUser.handler({ question: 'What type of document?' });
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: `Answer: ${result.content[0].text}` }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
    yield { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } };
  };

  it('keeps a detachable run alive when the consumer drops mid-question, then reconnects to finish it', async () => {
    sdkState.generator = askThenAnswer();

    // First connection drops at the question (browser disconnected)
    for await (const ev of runAgentTask({ role: 'pm', projectId: 1, input: 'start', detachable: true })) {
      if (ev.type === 'question') break;
    }

    // The run is left alive and parked — NOT interrupted or cancelled
    expect(sdkState.interrupt).not.toHaveBeenCalled();
    expect(updateJob).not.toHaveBeenCalledWith(42, { status: 'cancelled' });
    expect(hasPendingQuestion(42)).toBe(true);
    const run = getRun(42);
    expect(run).toBeDefined();
    expect(run.consumerAttached).toBe(false);

    // Reconnect: the question is re-emitted, then the agent continues once answered
    const events = [];
    for await (const ev of reattach(run)) {
      events.push(ev);
      if (ev.type === 'question') deliverReply(42, 'An NIH R01 grant');
    }
    expect(events[0]).toEqual({ type: 'question', agent: 'pm', jobId: 42, content: 'What type of document?' });
    expect(events.find((e) => e.type === 'text')).toMatchObject({ content: 'Answer: An NIH R01 grant' });
    expect(events.at(-1)).toMatchObject({ type: 'done', jobId: 42 });
    // Terminal completion removes the run from the registry
    expect(getRun(42)).toBeUndefined();
  });

  it('still interrupts and cancels a NON-detachable run that drops mid-question', async () => {
    sdkState.generator = askThenAnswer();

    for await (const ev of runAgentTask({ role: 'pm', projectId: 1, input: 'start' })) {
      if (ev.type === 'question') break; // browser disconnected; not detachable
    }

    expect(hasPendingQuestion(42)).toBe(false);
    expect(sdkState.interrupt).toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalledWith(42, { status: 'cancelled' });
    expect(getRun(42)).toBeUndefined();
  });

  it('does not register a run that finishes normally without disconnect', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'pm', projectId: 1, input: 'go' }); // not detachable
    expect(getRun(42)).toBeUndefined();
  });
});
