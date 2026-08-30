// Provider-neutral Kuhn tool registry contract (STH-1).
//
// Pins the seams that must hold no matter which AgentRuntime adapter
// projects these descriptors: enumeration by role grants (including the
// generated variants under broad grants), the provider_builtin web tool,
// the dispatch-depth visibility predicate, the normalized result envelope,
// server-derived identity (job/depth/budget/user attribution, context
// inheritance), and the storage/proposal behavior of file tools.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { agent: { maxDispatchDepth: 3, questionTimeoutMs: 30000, tokenBudget: 250000 } },
}));
vi.mock('../../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../../db/projects.js', () => ({
  getProject: vi.fn(async () => null),
  updateProjectConfig: vi.fn(async () => {}),
}));
vi.mock('../../storage.js', () => ({
  readProjectFile: vi.fn(async () => Buffer.from('alpha the sentence beta')),
  writeProjectFile: vi.fn(async (_p, path, content) => ({ path, content, created: true })),
  listProjectTree: vi.fn(async () => [{ path: 'draft/main.md', type: 'file' }]),
  searchProjectFiles: vi.fn(async () => []),
  moveProjectEntry: vi.fn(async (_p, from, to) => ({ from, to })),
}));
vi.mock('../../pending-edits.js', () => ({
  isProposable: vi.fn(async (_p, path) => path.startsWith('draft/')),
  proposeEdit: vi.fn(async (_p, spec) => ({ id: 7, path: spec.path })),
  effectiveContent: vi.fn(async () => 'file body'),
  pendingProposalContent: vi.fn(() => null),
}));
vi.mock('../../citations.js', () => ({
  DEFAULT_BIB_PATH: 'draft/references.bib',
  upsertCitation: vi.fn(async () => ({ key: 'smith2024', path: 'draft/references.bib' })),
  addReference: vi.fn(async () => ({ key: 'smith2024', path: 'draft/references.bib' })),
  updateReference: vi.fn(async () => ({ key: 'smith2024', path: 'draft/references.bib' })),
  removeReference: vi.fn(async () => ({ key: 'smith2024', path: 'draft/references.bib' })),
  isDerivedBibPath: vi.fn(async () => false),
}));
vi.mock('../../db/comments.js', () => ({
  resolveQuote: (content, quote) => {
    const i = content.indexOf(quote);
    return i === -1 ? null : { start: i, end: i + quote.length };
  },
  createThread: vi.fn(async () => ({ id: 5, path: 'draft/main.md', body: 'x' })),
  listThreads: vi.fn(async () => []),
  addReply: vi.fn(async (_p, _root, { body }) => ({ id: 90, path: 'draft/main.md', body })),
  setResolved: vi.fn(async () => ({ id: 5, path: 'draft/main.md', resolvedAt: '2026-08-07T00:00:00Z' })),
}));
vi.mock('../../db/org-documents.js', () => ({
  searchOrgKnowledge: vi.fn(() => []),
  hasReadyOrgDocuments: vi.fn(() => false),
}));
vi.mock('../search.js', () => ({
  pubmedSearch: vi.fn(async () => [{ title: 'A paper' }]),
  arxivSearch: vi.fn(async () => []),
}));
vi.mock('../../db/file-activity.js', () => ({ recordFileEvent: vi.fn() }));
vi.mock('../../db/move-paths.js', () => ({
  applyMove: vi.fn((_p, from, to) => ({ from, to })),
  findPendingEditConflicts: vi.fn(() => []),
}));
vi.mock('../../db/org-scripts.js', () => ({
  getOrgScript: vi.fn(() => null),
  getScriptVersion: vi.fn(() => null),
  listOrgScripts: vi.fn(() => []),
}));
vi.mock('../../db/script-runs.js', () => ({ recordScriptRun: vi.fn(async () => ({ id: 1 })) }));
vi.mock('../../sandbox.js', () => ({
  SandboxError: class SandboxError extends Error {},
  RUNNABLE_LANGUAGES: ['python'],
  runScriptSandboxed: vi.fn(async () => ({ status: 'ok', stdout: 'out', stderr: '' })),
}));
vi.mock('../../project-events.js', () => ({ publishProjectEvent: vi.fn() }));
vi.mock('../project-config.js', () => ({ applyProjectConfig: vi.fn(async () => ({})) }));

import { createToolContext, listTools, findTool } from './registry.js';
import { toolOk, toolError, toolResult } from './envelope.js';
import { validateArgs } from './validate.js';
import { writeProjectFile } from '../../storage.js';
import { isProposable, proposeEdit } from '../../pending-edits.js';
import { createThread } from '../../db/comments.js';
import { deliverReply } from '../questions.js';

const ALL_GRANTS = [
  'file_read', 'file_list', 'file_move', 'file_write',
  'add_citation', 'add_reference', 'manage_references',
  'add_comment', 'manage_comments',
  'pubmed_search', 'arxiv_search', 'search_org_knowledge',
  'run_script', 'ask_user', 'spawn_agent', 'project_config', 'web_search',
];

// Stable domain order as the provider sees it (factory order + web_search).
const EXPECTED_ORDER = [
  'read_file', 'search_files', 'list_files', 'move_file', 'write_file', 'edit_file',
  'add_citation', 'add_reference', 'update_reference', 'remove_reference',
  'add_comment', 'list_comments', 'reply_comment', 'resolve_comment',
  'pubmed_search', 'arxiv_search', 'search_org_knowledge',
  'list_scripts', 'run_script',
  'ask_user', 'dispatch_agent',
  'save_project_config',
  'web_search',
];

let pushed;
function makeCtx(overrides = {}) {
  pushed = [];
  const ctx = createToolContext({
    agent: { slug: 'ra', name: 'RA', system_prompt: '', model: 'm', tools: [...ALL_GRANTS] },
    projectId: 1,
    depth: 0,
    budget: { used: 0, limit: 1000 },
    parentJob: { id: 42 },
    channel: { push: (e) => pushed.push(e) },
    userId: 3,
    seeding: false,
    context: null,
    dispatch: async function* () {},
    ...overrides,
  });
  return ctx;
}
const agent = (tools) => ({ slug: 'ra', name: 'RA', system_prompt: '', model: 'm', tools });
const run = (tool, args) => tool.execute('call-1', args);

beforeEach(() => {
  vi.clearAllMocks();
  writeProjectFile.mockResolvedValue({ path: 'p', content: '', created: true });
});

describe('enumeration by role and mode (STH-1)', () => {
  it('enumerates every granted tool in stable domain order', () => {
    const tools = listTools(makeCtx());
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_ORDER);
  });

  it('enumerates only the grants the role holds', () => {
    const ctx = makeCtx({ agent: agent(['file_read', 'pubmed_search']) });
    const names = listTools(ctx).map((t) => t.name);
    expect(names).toEqual(['read_file', 'search_files', 'pubmed_search']);
  });

  it('expands broad grants into their generated variants', () => {
    const ctx = makeCtx({ agent: agent(['manage_references', 'manage_comments', 'run_script']) });
    const names = listTools(ctx).map((t) => t.name);
    // Broad grants carry their single-tool siblings plus the generated
    // management variants; nothing else.
    expect(names).toEqual([
      'update_reference', 'remove_reference',
      'list_comments', 'reply_comment', 'resolve_comment',
      'list_scripts', 'run_script',
    ]);
  });

  it('describes provider_builtin web_search without a Kuhn executor', () => {
    const web = findTool(makeCtx(), 'web_search');
    expect(web.kind).toBe('provider_builtin');
    expect(web.execute).toBeNull();
    expect(web.parameters.properties.query).toMatchObject({ type: 'string' });
  });

  it('withholds dispatch_agent at the maximum dispatch depth', () => {
    const atLimit = listTools(makeCtx({ depth: 3 })).map((t) => t.name);
    expect(atLimit).not.toContain('dispatch_agent');
    const belowLimit = listTools(makeCtx({ depth: 2 })).map((t) => t.name);
    expect(belowLimit).toContain('dispatch_agent');
  });

  it('every descriptor carries the full neutral contract', () => {
    for (const tool of listTools(makeCtx())) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(Array.isArray(tool.grants)).toBe(true);
      expect(tool.readOnly).toBeTypeOf('boolean');
      expect(typeof tool.effect).toBe('string');
      if (tool.kind !== 'provider_builtin') {
        expect(typeof tool.execute).toBe('function');
      }
      // The descriptor surface is provider-neutral: no Claude/Pi identifiers.
      const surface = JSON.stringify({ ...tool, execute: undefined });
      expect(surface).not.toMatch(/claude|zod|mcp|pi-spike/i);
    }
  });
});

describe('result envelope (STH-1)', () => {
  it('shapes success and error results', () => {
    expect(toolOk('done')).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(toolError('nope')).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
    expect(toolOk('x', { a: 1 }).details).toEqual({ a: 1 });
    expect(toolResult('x', { isError: true }).isError).toBe(true);
  });

  it('tool failures are data, not exceptions', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']) });
    writeProjectFile.mockRejectedValueOnce(new Error('disk full'));
    const result = await run(findTool(ctx, 'write_file'), { path: 'notes.md', content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('disk full');
    // No product event escaped for a failed write (STH-44).
    expect(pushed.filter((e) => e.type === 'file_change')).toEqual([]);
  });
});

describe('argument validation at the executor boundary (STH-1)', () => {
  it('validates against the descriptor schema, stripping unknown keys', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']) });
    const tool = findTool(ctx, 'write_file');
    const bad = validateArgs(tool.parameters, { path: 'notes.md' }); // content missing
    expect(bad.ok).toBe(false);
    const good = validateArgs(tool.parameters, { path: 'notes.md', content: 'x', extra: 1 });
    expect(good.ok).toBe(true);
    expect(good.value).toEqual({ path: 'notes.md', content: 'x' });
  });
});

describe('storage and proposal behavior (STH-1 / STH-44)', () => {
  it('writes a non-draft path directly and emits a file_change', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']) });
    const result = await run(findTool(ctx, 'write_file'), { path: 'notes.md', content: 'hello' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'Created notes.md' }] });
    expect(writeProjectFile).toHaveBeenCalledWith(1, 'notes.md', 'hello');
    expect(proposeEdit).not.toHaveBeenCalled();
    expect(pushed).toContainEqual({ type: 'file_change', agent: 'ra', path: 'notes.md', kind: 'create' });
  });

  it('proposes a draft/ write instead of writing, and says so', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']) });
    const result = await run(findTool(ctx, 'write_file'), { path: 'draft/main.md', content: 'hello' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^Successfully proposed update to draft\/main\.md/);
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(proposeEdit).toHaveBeenCalledWith(1, expect.objectContaining({
      path: 'draft/main.md', proposedContent: 'hello', agentSlug: 'ra', jobId: 42,
    }));
    expect(pushed).toContainEqual({ type: 'file_change', agent: 'ra', path: 'draft/main.md', kind: 'proposed' });
  });

  it('bypasses the proposal gate while seeding', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']), seeding: true });
    await run(findTool(ctx, 'write_file'), { path: 'draft/main.md', content: 'hello' });
    expect(isProposable).not.toHaveBeenCalled();
    expect(writeProjectFile).toHaveBeenCalledWith(1, 'draft/main.md', 'hello');
    expect(pushed).toContainEqual({ type: 'file_change', agent: 'ra', path: 'draft/main.md', kind: 'create' });
  });

  it('edit_file applies to the effective content under suggestion mode', async () => {
    const ctx = makeCtx({ agent: agent(['file_write']) });
    const result = await run(findTool(ctx, 'edit_file'), {
      path: 'draft/main.md', old_string: 'file', new_string: 'doc',
    });
    expect(result.content[0].text).toMatch(/^Successfully proposed update to draft\/main\.md/);
    expect(proposeEdit).toHaveBeenCalledWith(1, expect.objectContaining({
      path: 'draft/main.md', proposedContent: 'doc body',
    }));
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it('move_file records the canonical paths and mirrors the moved event', async () => {
    const ctx = makeCtx({ agent: agent(['file_move']) });
    const result = await run(findTool(ctx, 'move_file'), { from: 'a.md', to: 'b/a.md' });
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ from: 'a.md', to: 'b/a.md' });
    expect(pushed).toContainEqual({
      type: 'file_change', agent: 'ra', path: 'b/a.md', kind: 'moved', meta: { from: 'a.md' },
    });
  });
});

describe('server-derived identity (STH-1)', () => {
  it('dispatch_agent inherits depth, shared budget, job attribution, and context', async () => {
    const dispatchCalls = [];
    const ctx = makeCtx({
      agent: agent(['spawn_agent']),
      context: { activeDocument: 'draft/lit.md', dir: 'draft' },
      dispatch: async function* (task, internal) {
        dispatchCalls.push({ task, internal });
        yield { type: 'text', agent: 'ra', content: 'child result' };
      },
    });
    const result = await run(findTool(ctx, 'dispatch_agent'), { agent_slug: 'writer', task: 'write the intro' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('child result');
    expect(dispatchCalls).toHaveLength(1);
    const { task, internal } = dispatchCalls[0];
    expect(task).toMatchObject({ role: 'writer', projectId: 1, userId: 3, seeding: false });
    expect(task.input).toBe('write the intro');
    expect(task.context).toEqual({ activeDocument: 'draft/lit.md', dir: 'draft' });
    expect(internal).toMatchObject({ depth: 1, parentJobId: 42 });
    expect(internal.budget).toBe(ctx.budget); // one budget shared by the tree
  });

  it('dispatch_agent folds sub-agent text and surfaces failures', async () => {
    const ctx = makeCtx({
      agent: agent(['spawn_agent']),
      dispatch: async function* () {
        yield { type: 'text', agent: 'ra', content: 'part one' };
        yield { type: 'error', agent: 'ra', jobId: 42, message: 'child failed' };
      },
    });
    const result = await run(findTool(ctx, 'dispatch_agent'), { agent_slug: 'writer', task: 't' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('child failed');
  });

  it('ask_user emits the question with job attribution and resolves via deliverReply', async () => {
    const ctx = makeCtx({ agent: agent(['ask_user']) });
    const promise = run(findTool(ctx, 'ask_user'), { question: 'Which tone?' });
    expect(pushed).toContainEqual({ type: 'question', agent: 'ra', jobId: 42, content: 'Which tone?' });
    deliverReply(42, 'warm');
    const result = await promise;
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'warm' }] });
    expect(pushed.some((e) => e.type === 'question_expired')).toBe(false);
  });

  it('add_comment threads carry server-derived attribution, anchored to the quote', async () => {
    const ctx = makeCtx({ agent: agent(['add_comment']) });
    const result = await run(findTool(ctx, 'add_comment'), {
      path: 'draft/main.md', body: 'check this', quote: 'the sentence',
    });
    expect(result.isError).toBeUndefined();
    expect(createThread).toHaveBeenCalledWith(1, expect.objectContaining({
      path: 'draft/main.md',
      body: 'check this',
      quote: 'the sentence',
      agentSlug: 'ra',
      jobId: 42,
    }));
  });
});
