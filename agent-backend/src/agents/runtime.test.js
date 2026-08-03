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
    // db.js loads at import via the history module (story 008-002); keep it
    // in-memory and history itself inert in these tests.
    db: { path: ':memory:' },
    history: { enabled: false },
    agent: {
      tokenBudget: 250000,
      budgetGrace: 1.1,
      maxDispatchDepth: 2,
      questionTimeoutMs: 15 * 60 * 1000,
      model: undefined,
      modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 },
      // Zero delays so the backoff retry path (story 029) runs instantly in tests.
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    },
    // The real project-events hub runs in these tests (the channel tee
    // publishes into it); subscribing to it needs this cap (story 012-002).
    projectEvents: { maxSubscribers: 25 },
  },
}));

vi.mock('../storage.js', () => ({
  resolveProjectDir: vi.fn(async (projectId) => `/projects/${projectId}`),
  readProjectFile: vi.fn(async () => Buffer.from('file body')),
  writeProjectFile: vi.fn(async () => ({ created: true })),
  listProjectTree: vi.fn(async () => []),
  searchProjectFiles: vi.fn(async () => []),
  moveProjectEntry: vi.fn(async () => ({})),
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
  getProject: vi.fn(async (id) => ({ id, org_id: 3 })),
}));
// Like file-activity.js above: the real module imports db.js, which needs a
// real config.db.path at import time (story 006-003).
vi.mock('../db/org-documents.js', () => ({
  searchOrgKnowledge: vi.fn(() => []),
  hasReadyOrgDocuments: vi.fn(() => true),
}));
vi.mock('../citations.js', () => ({
  DEFAULT_BIB_PATH: 'draft/references.bib',
  upsertCitation: vi.fn(async () => ({ key: 'k', created: true, bibtex: '@article{k}', path: 'draft/references.bib' })),
  addReference: vi.fn(async () => ({ key: 'k', created: true, bibtex: '@article{k}', path: 'draft/references.bib' })),
  updateReference: vi.fn(async () => ({ key: 'k', bibtex: '@article{k, year = {2024}}', path: 'draft/references.bib' })),
  removeReference: vi.fn(async () => ({ key: 'k', path: 'draft/references.bib' })),
  isDerivedBibPath: vi.fn(async () => false),
}));
// Keeps db.js (which needs a real config.db.path at import) out of this
// mocked-config suite; the SQL is covered in db/file-activity.test.js.
vi.mock('../db/file-activity.js', () => ({ migrateSeenPaths: vi.fn(), recordFileEvent: vi.fn() }));
// Same reason: the move seam's transactional rewrite is real SQL, covered in
// db/move-paths.test.js. project-events.js (deliberately NOT mocked here) is
// the module that calls applyMove (story 012-002).
vi.mock('../db/move-paths.js', () => ({
  applyMove: vi.fn((_projectId, from, to) => ({ from, to })),
  findPendingEditConflicts: vi.fn(() => []),
}));
// Suggestion-mode service (story 008-001): the real scope rule, mocked IO —
// the diff/apply/orchestration substance is covered in ../pending-edits.test.js.
vi.mock('../pending-edits.js', () => ({
  isSuggestionPath: (p) => typeof p === 'string' && p.split('/')[0] === 'draft',
  proposeEdit: vi.fn(async (_projectId, { path }) => ({ id: 1, path })),
  effectiveContent: vi.fn(async () => 'file body'),
  pendingProposalContent: vi.fn(() => null),
}));

import { query as sdkQuery, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { proposeEdit, effectiveContent, pendingProposalContent } from '../pending-edits.js';
import { isDerivedBibPath, updateReference, removeReference } from '../citations.js';
import { searchOrgKnowledge, hasReadyOrgDocuments } from '../db/org-documents.js';
import { writeProjectFile, moveProjectEntry } from '../storage.js';
import { recordFileEvent } from '../db/file-activity.js';
import { applyMove, findPendingEditConflicts } from '../db/move-paths.js';
import { subscribeProjectEvents } from '../project-events.js';
import { getAgentWithTools } from '../db/agents.js';
import { createConversation, logMessage } from '../db/conversation.js';
import { createJob, updateJob } from '../db/jobs.js';
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
        budget: { used: 15, limit: 250000 },
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
    // An agent-owned path (008-001: draft/** goes through suggestion mode instead)
    const result = await writeTool.handler({ path: 'research/notes.md', content: 'hello' });
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'research/notes.md', 'hello');
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

// --- Story 008-001: suggestion mode for agent edits ---------------------------

describe('suggestion mode (story 008-001)', () => {
  const WRITER = { ...RA_AGENT, slug: 'writer', tools: ['file_write', 'spawn_agent'] };
  const success = () => [
    { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  async function fileTools(task) {
    getAgentWithTools.mockResolvedValue(WRITER);
    sdkState.messages = success();
    await collect(task);
    const { tools } = createSdkMcpServer.mock.calls.at(-1)[0];
    return {
      write: tools.find((t) => t.name === 'write_file'),
      edit: tools.find((t) => t.name === 'edit_file'),
      dispatch: tools.find((t) => t.name === 'dispatch_agent'),
    };
  }

  it('write_file to draft/** proposes a pending edit instead of writing', async () => {
    const { write } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    const result = await write.handler({ path: 'draft/main.md', content: 'new draft' });
    expect(proposeEdit).toHaveBeenCalledWith(7, {
      path: 'draft/main.md', proposedContent: 'new draft', agentSlug: 'writer', jobId: 42,
    });
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Successfully proposed update to draft\/main\.md/);
    expect(result.content[0].text).toMatch(/COMPLETE — do not retry/);
    expect(result.content[0].text).toMatch(/changes only when they accept/);
  });

  it('write_file outside the scope keeps direct writes (draft- prefix is not draft/)', async () => {
    const { write } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    for (const path of ['research/summary.md', 'pm/status.md', 'draft-notes/x.md']) {
      const result = await write.handler({ path, content: 'x' });
      expect(result.content[0].text).toMatch(/^Created /);
    }
    expect(writeProjectFile).toHaveBeenCalledTimes(3);
    expect(proposeEdit).not.toHaveBeenCalled();
  });

  it('the seeding flag bypasses the gate — the pipeline writes draft/** directly', async () => {
    const { write } = await fileTools({ role: 'writer', projectId: 7, input: 'go', seeding: true });
    const result = await write.handler({ path: 'draft/main.md', content: 'skeleton' });
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'draft/main.md', 'skeleton');
    expect(proposeEdit).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/^Created draft\/main\.md/);
  });

  it('edit_file on a scoped path edits the EFFECTIVE content and re-proposes', async () => {
    effectiveContent.mockResolvedValueOnce('pending proposal body');
    const { edit } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    const result = await edit.handler({
      path: 'draft/main.md', old_string: 'proposal', new_string: 'draft', replace_all: false,
    });
    expect(effectiveContent).toHaveBeenCalledWith(7, 'draft/main.md');
    expect(proposeEdit).toHaveBeenCalledWith(7, {
      path: 'draft/main.md', proposedContent: 'pending draft body', agentSlug: 'writer', jobId: 42,
    });
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/Successfully proposed update/);
  });

  it('edit_file old_string misses are still validated against the effective content', async () => {
    effectiveContent.mockResolvedValueOnce('pending proposal body');
    const { edit } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    const result = await edit.handler({
      path: 'draft/main.md', old_string: 'nope', new_string: 'x', replace_all: false,
    });
    expect(result.isError).toBe(true);
    expect(proposeEdit).not.toHaveBeenCalled();
  });

  it('edit_file outside the scope still reads the disk file and writes directly', async () => {
    const { edit } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    const result = await edit.handler({
      path: 'research/notes.md', old_string: 'file', new_string: 'disk', replace_all: false,
    });
    expect(effectiveContent).not.toHaveBeenCalled();
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'research/notes.md', 'disk body');
    expect(result.content[0].text).toMatch(/^Updated research\/notes\.md/);
  });

  it("fileChangeEvent reports scoped writes as kind 'proposed' — but 'create' while seeding", async () => {
    const turn = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'mcp__kuhn__write_file', input: { path: 'draft/main.md', content: 'x' } },
          { type: 'tool_use', id: 't2', name: 'mcp__kuhn__edit_file', input: { path: 'draft/main.md', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 't3', name: 'mcp__kuhn__write_file', input: { path: 'research/s.md', content: 'x' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    getAgentWithTools.mockResolvedValue(WRITER);
    sdkState.messages = [turn, ...success()];
    const events = await collect({ role: 'writer', projectId: 7, input: 'go' });
    expect(events.filter((e) => e.type === 'file_change').map((e) => [e.path, e.kind])).toEqual([
      ['draft/main.md', 'proposed'],
      ['draft/main.md', 'proposed'],
      ['research/s.md', 'create'],
    ]);

    sdkState.messages = [turn, ...success()];
    const seeded = await collect({ role: 'writer', projectId: 7, input: 'go', seeding: true });
    expect(seeded.filter((e) => e.type === 'file_change').map((e) => e.kind)).toEqual([
      'create', 'update', 'create',
    ]);
  });

  it('read_file on a path with a pending proposal returns the PROPOSED content (issue #42)', async () => {
    pendingProposalContent.mockReturnValueOnce('proposed body');
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, tools: ['file_read'] });
    sdkState.messages = success();
    await collect({ role: 'ra', projectId: 7, input: 'go' });
    const tools = createSdkMcpServer.mock.calls.at(-1)[0].tools;
    const read = tools.find((t) => t.name === 'read_file');
    const result = await read.handler({ path: 'draft/main.md' });
    expect(result.content[0].text).toMatch(/pending proposed update awaiting user review/);
    expect(result.content[0].text).toMatch(/proposed body$/);
  });

  it('read_file without a pending proposal (or while seeding) reads the disk file', async () => {
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, tools: ['file_read'] });
    sdkState.messages = success();
    await collect({ role: 'ra', projectId: 7, input: 'go', seeding: true });
    const tools = createSdkMcpServer.mock.calls.at(-1)[0].tools;
    const read = tools.find((t) => t.name === 'read_file');
    const result = await read.handler({ path: 'draft/main.md' });
    expect(pendingProposalContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('file body');
  });

  it('write_file and edit_file refuse a derived bibliography path (issue #42)', async () => {
    isDerivedBibPath.mockResolvedValue(true);
    const { write, edit } = await fileTools({ role: 'writer', projectId: 7, input: 'go' });
    const w = await write.handler({ path: 'draft/references.bib', content: '@article{x}' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/generated from the project reference store/);
    expect(w.content[0].text).toMatch(/add_citation/);
    const e = await edit.handler({ path: 'draft/references.bib', old_string: 'a', new_string: 'b', replace_all: false });
    expect(e.isError).toBe(true);
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(proposeEdit).not.toHaveBeenCalled();
    isDerivedBibPath.mockResolvedValue(false);
  });

  it('sub-agents dispatched by a seeding stage inherit the bypass', async () => {
    const { dispatch } = await fileTools({ role: 'writer', projectId: 7, input: 'go', seeding: true });
    sdkState.messages = success();
    await dispatch.handler({ agent_slug: 'writer', task: 'flesh out methods' });

    const childTools = createSdkMcpServer.mock.calls.at(-1)[0].tools;
    const write = childTools.find((t) => t.name === 'write_file');
    await write.handler({ path: 'draft/methods.md', content: 'methods' });
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'draft/methods.md', 'methods');
    expect(proposeEdit).not.toHaveBeenCalled();
  });
});

// --- Issue #41: deterministic reference correction tools ----------------------

describe('manage_references tools (issue #41)', () => {
  const LIBRARIAN = { ...RA_AGENT, tools: ['manage_references'] };
  const success = () => [
    { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  async function refTools() {
    getAgentWithTools.mockResolvedValue(LIBRARIAN);
    sdkState.messages = success();
    const events = [];
    for await (const ev of runAgentTask({ role: 'ra', projectId: 7, input: 'go' })) events.push(ev);
    const { tools } = createSdkMcpServer.mock.calls.at(-1)[0];
    return {
      update: tools.find((t) => t.name === 'update_reference'),
      remove: tools.find((t) => t.name === 'remove_reference'),
    };
  }

  it('is gated by the manage_references tool slug', async () => {
    getAgentWithTools.mockResolvedValue(RA_AGENT); // no manage_references
    sdkState.messages = success();
    for await (const _ of runAgentTask({ role: 'ra', projectId: 7, input: 'go' })) { /* drain */ }
    const names = createSdkMcpServer.mock.calls.at(-1)[0].tools.map((t) => t.name);
    expect(names).not.toContain('update_reference');
    expect(names).not.toContain('remove_reference');
  });

  it('update_reference maps snake_case params, emits citation + file_change, returns the entry', async () => {
    const { update } = await refTools();
    const result = await update.handler({
      cite_key: 'k', year: 2024, entry_type: 'misc', source_type: 'preprint', path: 'draft/references.bib',
    });
    expect(updateReference).toHaveBeenCalledWith(
      7, 'k', { year: 2024, entryType: 'misc', sourceType: 'preprint' }, 'draft/references.bib',
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Updated reference "k"/);
    expect(result.content[0].text).toContain('@article{k, year = {2024}}');
  });

  it('remove_reference deletes by cite key and emits file_change', async () => {
    const { remove } = await refTools();
    const result = await remove.handler({ cite_key: 'k', path: 'draft/references.bib' });
    expect(removeReference).toHaveBeenCalledWith(7, 'k', 'draft/references.bib');
    expect(result.content[0].text).toMatch(/Removed reference "k"/);
  });

  it('maps service errors (unknown cite key) to isError tool results', async () => {
    updateReference.mockRejectedValueOnce(new Error('No reference with cite key "nope"'));
    const { update } = await refTools();
    const result = await update.handler({ cite_key: 'nope', year: 2020, path: 'draft/references.bib' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/update_reference failed: No reference/);
  });
});

// --- Story 007-001: user attribution on jobs/conversations/messages ----------

describe('user attribution (story 007-001)', () => {
  const successMessages = () => [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'mcp__kuhn__read_file', input: { path: 'a.md' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  it('stamps each run\'s user on its job, conversation, and every message row — including a second user resuming the shared per-role session', async () => {
    sdkState.messages = successMessages();
    await collect({ role: 'ra', projectId: 1, input: 'question from A', userId: 1 });
    // User B continues the same project/agent stream (today's shared-session
    // behavior, story-013 known issue): B's rows still carry B, not A.
    sdkState.messages = successMessages();
    await collect({ role: 'ra', projectId: 1, input: 'question from B', sessionId: 'sess-1', userId: 2 });

    expect(createJob.mock.calls.map(([j]) => j.userId)).toEqual([1, 2]);
    expect(createConversation.mock.calls.map((c) => c[2])).toEqual([1, 2]);
    // user + assistant + tool rows all carry the run's user (007-001 AC)
    const byRun = logMessage.mock.calls.map(([m]) => [m.role, m.userId]);
    expect(byRun.slice(0, 3)).toEqual([['user', 1], ['assistant', 1], ['tool', 1]]);
    expect(byRun.slice(3)).toEqual([['user', 2], ['assistant', 2], ['tool', 2]]);
  });

  it('leaves user_id NULL when no session user is supplied', async () => {
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(createJob.mock.calls[0][0].userId).toBeNull();
    expect(logMessage.mock.calls[0][0].userId).toBeNull();
  });

  it('sub-agent dispatches inherit the dispatching user', async () => {
    getAgentWithTools.mockResolvedValue({ ...RA_AGENT, slug: 'pm', tools: ['spawn_agent'] });
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await collect({ role: 'pm', projectId: 1, input: 'go', userId: 5 });

    // Invoke the dispatch_agent handler the run registered with the MCP server.
    const dispatch = createSdkMcpServer.mock.calls[0][0].tools.find((t) => t.name === 'dispatch_agent');
    getAgentWithTools.mockResolvedValue(RA_AGENT);
    sdkState.messages = [
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await dispatch.handler({ agent_slug: 'ra', task: 'find papers' });

    expect(createJob.mock.calls.map(([j]) => [j.role, j.userId])).toEqual([['pm', 5], ['ra', 5]]);
  });
});

// --- Story 029: transient model-provider error resilience --------------------

describe('transient API error retry (story 029)', () => {
  const overloaded = () => Object.assign(new Error('API Error: 529 Overloaded'), { status: 529 });

  it('retries on a 529, emitting a notice, then succeeds without a terminal error', async () => {
    let calls = 0;
    sdkState.generator = () => (async function* () {
      calls += 1;
      if (calls === 1) throw overloaded(); // first attempt fails before any output
      yield { type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } };
    })();

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });

    expect(calls).toBe(2);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toMatchObject({ type: 'notice', reason: 'provider_overloaded', attempt: 1, maxAttempts: 3 });
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('surfaces a terminal provider_overloaded error after exhausting retries', async () => {
    sdkState.generator = () => (async function* () {
      throw overloaded();
      // eslint-disable-next-line no-unreachable
      yield {};
    })();

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });

    // maxAttempts 3 → 3 notices, then a terminal tagged error
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(3);
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', reason: 'provider_overloaded' });
    expect(error.message).toMatch(/overloaded/i);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });

  it('does not retry a non-transient error — surfaces it once, untagged', async () => {
    let calls = 0;
    sdkState.generator = () => (async function* () {
      calls += 1;
      throw new Error('schema validation failed');
      // eslint-disable-next-line no-unreachable
      yield {};
    })();

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });

    expect(calls).toBe(1);
    expect(events.find((e) => e.type === 'notice')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'schema validation failed' });
    expect(events.at(-1).reason).toBeUndefined();
  });

  it('hands back the session id on a terminal transient error so a chat retry can resume', async () => {
    sdkState.generator = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-resume' };
      throw overloaded();
    })();

    const events = await collect({ role: 'ra', projectId: 1, input: 'go' });
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ reason: 'provider_overloaded', sessionId: 'sess-resume' });
  });
});

describe('isTransientApiError (story 029)', () => {
  it('classifies overload / rate-limit / 5xx / network as transient', async () => {
    const { isTransientApiError } = await import('./runtime.js');
    expect(isTransientApiError(Object.assign(new Error('x'), { status: 529 }))).toBe(true);
    expect(isTransientApiError(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isTransientApiError(new Error('API Error: 429 rate limit'))).toBe(true);
    expect(isTransientApiError(new Error('Overloaded'))).toBe(true);
    expect(isTransientApiError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientApiError(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isTransientApiError(new Error('Unknown agent role: nope'))).toBe(false);
    expect(isTransientApiError(null)).toBe(false);
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
    // The project keeps the user's chosen name — only the type and config are
    // updated; the manuscript title lives in config.title (story: rename).
    expect(updateProjectConfig).toHaveBeenCalledWith(5, {
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

// --- Story 006-003: search_org_knowledge agent tool ---------------------------

describe('search_org_knowledge (story 006-003)', () => {
  const ADVISOR = {
    slug: 'advisor',
    name: 'Domain Expert (Advisor)',
    system_prompt: 'You are the advisor.',
    tools: ['file_read', 'search_org_knowledge'],
  };
  const success = [
    { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  async function orgSearchTool(role = 'advisor', projectId = 5) {
    sdkState.messages = success;
    await collect({ role, projectId, input: 'go' });
    const { tools } = createSdkMcpServer.mock.calls[0][0];
    return tools.find((t) => t.name === 'search_org_knowledge');
  }

  it('is exposed only to roles with the agent_tools assignment', async () => {
    getAgentWithTools.mockResolvedValue(ADVISOR);
    sdkState.messages = success;
    await collect({ role: 'advisor', projectId: 1, input: 'go' });
    expect(sdkQuery.mock.calls[0][0].options.allowedTools).toContain('mcp__kuhn__search_org_knowledge');

    // An agent without the assignment (the default RA fixture) never sees it
    getAgentWithTools.mockResolvedValue(RA_AGENT);
    sdkState.messages = success;
    await collect({ role: 'ra', projectId: 1, input: 'go' });
    expect(sdkQuery.mock.calls[1][0].options.allowedTools).not.toContain('mcp__kuhn__search_org_knowledge');
    const { tools } = createSdkMcpServer.mock.calls[1][0];
    expect(tools.find((t) => t.name === 'search_org_knowledge')).toBeUndefined();
  });

  it("resolves the org from the task project's org_id and returns passages with provenance", async () => {
    getAgentWithTools.mockResolvedValue(ADVISOR);
    searchOrgKnowledge.mockReturnValueOnce([
      {
        docId: 9, title: 'rwe-protocol/framework', filename: 'framework.pdf',
        headingPath: 'Considerations > Data Quality', seq: 3,
        snippet: '…>>real-world data<< must be fit for use…', rank: -4.2,
      },
      {
        docId: 12, title: null, filename: 'heliotrope.txt',
        headingPath: null, seq: 0, snippet: '…>>heliotrope<< pigment…', rank: -3.1,
      },
    ]);

    const searchTool = await orgSearchTool('advisor', 5);
    const result = await searchTool.handler({ query: 'real-world data quality', limit: 8 });

    // Org derived server-side from project 5 (mocked getProject → org_id 3);
    // the tool schema has no org parameter for the agent to set.
    expect(searchOrgKnowledge).toHaveBeenCalledWith(3, 'real-world data quality', 8);
    expect(Object.keys(searchTool.schema)).toEqual(['query', 'limit']);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Provenance line: document (title, falling back to filename) + section
    expect(text).toContain('Source: "rwe-protocol/framework" (framework.pdf) — section: Considerations > Data Quality');
    expect(text).toContain('real-world data');
    expect(text).toContain('Source: "heliotrope.txt" (heliotrope.txt)');
  });

  it('reports an empty library as a graceful no-retry result, not an error', async () => {
    getAgentWithTools.mockResolvedValue(ADVISOR);
    hasReadyOrgDocuments.mockReturnValueOnce(false);

    const searchTool = await orgSearchTool();
    const result = await searchTool.handler({ query: 'style guide', limit: 8 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/no library documents yet/i);
    expect(result.content[0].text).toMatch(/do not retry/i);
    expect(searchOrgKnowledge).not.toHaveBeenCalled();
  });

  it('distinguishes zero matches (in a populated library) from an empty library', async () => {
    getAgentWithTools.mockResolvedValue(ADVISOR);
    searchOrgKnowledge.mockReturnValueOnce([]);

    const searchTool = await orgSearchTool();
    const result = await searchTool.handler({ query: 'zeugma', limit: 8 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/No org library passages matched "zeugma"/);
  });

  it('surfaces backend failures as tool errors', async () => {
    getAgentWithTools.mockResolvedValue(ADVISOR);
    searchOrgKnowledge.mockImplementationOnce(() => { throw new Error('fts index corrupt'); });

    const searchTool = await orgSearchTool();
    const result = await searchTool.handler({ query: 'anything', limit: 8 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/fts index corrupt/);
  });
});

// --- Story 012-002: move_file emits one identity-preserving 'moved' event -----

describe('move_file tool (story 012-002)', () => {
  const ORGANIZER = { ...RA_AGENT, tools: ['file_move'] };

  // Drives the tool from INSIDE a live run: the channel is still open, so both
  // the agent event stream and the project feed see what the move emits.
  async function runMove(args) {
    getAgentWithTools.mockResolvedValue(ORGANIZER);
    let result;
    sdkState.generator = async function* () {
      const { tools } = createSdkMcpServer.mock.calls.at(-1)[0];
      const move = tools.find((t) => t.name === 'move_file');
      result = await move.handler(args);
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    const feed = [];
    const unsubscribe = subscribeProjectEvents(7, (e) => feed.push(e));
    const events = await collect({ role: 'ra', projectId: 7, input: 'organize' });
    unsubscribe();
    return {
      result,
      changes: events.filter((e) => e.type === 'file_change'),
      feedChanges: feed.filter((e) => e.type === 'file_change'),
    };
  }

  it('pushes ONE moved event with the canonical paths, never a delete+create pair', async () => {
    // The model's raw arguments are not canonical; storage reports what it
    // actually renamed, and that is what has to be published.
    moveProjectEntry.mockResolvedValueOnce({ from: 'sources/protocol.pdf', to: 'seed_docs/protocol.pdf' });

    const { result, changes, feedChanges } = await runMove({ from: './sources/protocol.pdf', to: 'seed_docs/protocol.pdf' });

    expect(moveProjectEntry).toHaveBeenCalledWith(7, './sources/protocol.pdf', 'seed_docs/protocol.pdf');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Moved sources/protocol.pdf → seed_docs/protocol.pdf');

    const moved = {
      type: 'file_change',
      agent: 'ra',
      path: 'seed_docs/protocol.pdf',
      kind: 'moved',
      meta: { from: 'sources/protocol.pdf' },
    };
    expect(changes).toEqual([moved]);
    // Deduped by the hub's WeakSet: the direct publish and the channel tee
    // offer the same object, and the feed still sees exactly one envelope.
    expect(feedChanges).toHaveLength(1);
    expect(feedChanges[0]).toMatchObject(moved);
  });

  it('routes the rewrite through applyMove with job/user attribution, not a bare activity row', async () => {
    moveProjectEntry.mockResolvedValueOnce({ from: 'a.md', to: 'dir/a.md' });

    await runMove({ from: 'a.md', to: 'dir/a.md' });

    expect(applyMove).toHaveBeenCalledTimes(1);
    expect(applyMove).toHaveBeenCalledWith(7, 'a.md', 'dir/a.md', {
      agentSlug: 'ra', jobId: 42, userId: null,
    });
    // No delete/create rows: applyMove owns the single 'moved' row.
    expect(recordFileEvent).not.toHaveBeenCalled();
  });

  it('refuses the move when a pending proposal already sits at the destination', async () => {
    findPendingEditConflicts.mockReturnValueOnce(['draft/methods.md']);

    const { result, changes } = await runMove({ from: 'draft/notes.md', to: 'draft/methods.md' });

    // Checked BEFORE the rename, so the file is still where it was.
    expect(moveProjectEntry).not.toHaveBeenCalled();
    expect(applyMove).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/pending proposed edit is already waiting at draft\/methods\.md/);
    expect(changes).toEqual([]);
  });

  it('compensates with a rename-back when the rewrite fails, and reports it as a tool error', async () => {
    moveProjectEntry.mockResolvedValueOnce({ from: 'a.md', to: 'dir/a.md' });
    applyMove.mockImplementationOnce(() => { throw new Error('database is locked'); });

    const { result, changes, feedChanges } = await runMove({ from: 'a.md', to: 'dir/a.md' });

    expect(moveProjectEntry).toHaveBeenNthCalledWith(1, 7, 'a.md', 'dir/a.md');
    expect(moveProjectEntry).toHaveBeenNthCalledWith(2, 7, 'dir/a.md', 'a.md');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Move failed: database is locked\. a\.md was left in place\./);
    // Nobody is told a move happened when the rewrite did not commit.
    expect(changes).toEqual([]);
    expect(feedChanges).toEqual([]);
  });

  it('says so when the compensating rename-back also fails', async () => {
    moveProjectEntry
      .mockResolvedValueOnce({ from: 'a.md', to: 'dir/a.md' })
      .mockRejectedValueOnce(new Error('EIO'));
    applyMove.mockImplementationOnce(() => { throw new Error('database is locked'); });

    const { result } = await runMove({ from: 'a.md', to: 'dir/a.md' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/a\.md could NOT be restored and is now at dir\/a\.md/);
  });
});
