import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------

const sdkState = { messages: [], interrupt: vi.fn(async () => {}) };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    const iterator = (async function* () {
      for (const m of sdkState.messages) yield m;
    })();
    iterator.interrupt = sdkState.interrupt;
    return iterator;
  }),
  tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: vi.fn((cfg) => ({ type: 'sdk', name: cfg.name })),
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

import { query as sdkQuery, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { writeProjectFile } from '../storage.js';
import { getAgentWithTools } from '../db/agents.js';
import { logMessage } from '../db/conversation.js';
import { updateJob } from '../db/jobs.js';
import { runAgentTask } from './runtime.js';

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
