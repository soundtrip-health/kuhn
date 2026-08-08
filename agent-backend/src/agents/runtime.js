// Story 011: Agent runtime on the Claude Agent SDK, behind the agent-task
// boundary. The rest of the system depends only on runAgentTask(); the SDK
// is an implementation detail of this module.

import { query as sdkQuery, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { config } from '../config.js';
import { getAgentWithTools } from '../db/agents.js';
import { createConversation, logMessage } from '../db/conversation.js';
import { createJob, updateJob } from '../db/jobs.js';
import { getProject } from '../db/projects.js';
import { searchOrgKnowledge, hasReadyOrgDocuments } from '../db/org-documents.js';
import {
  resolveProjectDir,
  readProjectFile,
  writeProjectFile,
  listProjectTree,
  searchProjectFiles,
  moveProjectEntry,
} from '../storage.js';
import { DEFAULT_BIB_PATH, upsertCitation, addReference, updateReference, removeReference, isDerivedBibPath } from '../citations.js';
import { findPendingEditConflicts } from '../db/move-paths.js';
import { addReply, createThread, listThreads, resolveQuote, setResolved } from '../db/comments.js';
import { isSuggestionPath, proposeEdit, effectiveContent, pendingProposalContent } from '../pending-edits.js';
import { publishProjectEvent } from '../project-events.js';
import { EventChannel } from './events.js';
import { waitForReply, cancelQuestion, hasPendingQuestion, getPendingQuestion } from './questions.js';
import { registerRun, unregisterRun } from './runs.js';
import { pubmedSearch, arxivSearch } from './search.js';
import { applyProjectConfig } from './project-config.js';

// DB tool slug → built-in SDK tool names. File access deliberately maps to
// no built-ins (story 018): agents get storage-backed MCP tools instead, so
// every file operation goes through the project-root-enforcing storage
// service. Tools not granted to a role are removed entirely via the SDK
// `tools` option (allowedTools alone does not restrict anything under
// permissionMode: 'bypassPermissions').
const BUILTIN_TOOL_MAP = {
  web_search: ['WebSearch', 'WebFetch'],
};

const MAX_TURNS = parseInt(process.env.AGENT_MAX_TURNS || '50');

/**
 * Run an agent task. The only contract the rest of the system sees.
 *
 * @param {object} task
 * @param {string} task.role - 'pm' | 'writer' | 'analyst' | 'advisor' | 'research'/'ra' | 'review'/'reviewer'
 * @param {number|string} task.projectId - Project whose workspace the task may touch
 * @param {string} task.input - User message or dispatch instruction
 * @param {number|null} [task.userId] - Session user for attribution (story
 *   007-001): stamped on the job, conversation, messages, and file events;
 *   sub-agent dispatches inherit it
 * @param {object} [task.context] - Optional editor context: { selection, cursor: {line}, files }
 * @param {string} [task.sessionId] - Continue a prior SDK session
 * @param {boolean} [task.compose] - Compose mode (story 017): withhold file-mutating
 *   tools so the agent returns text only and emits no file_change (the /write contract)
 * @param {boolean} [task.seeding] - Seeding-pipeline bypass (story 008-001):
 *   suggestion mode normally turns agent writes to draft/** into pending edits;
 *   the seeding stages write the first draft directly (nothing to protect yet).
 *   Sub-agent dispatches inherit it.
 * @param {object} [internal] - Used by dispatch_agent for sub-tasks; not part of the boundary
 * @returns {AsyncGenerator<AgentEvent>} Events:
 *   { type: 'text_delta', agent, content }   — token-level streaming (story 013)
 *   { type: 'text', agent, content }         — full text of the finished turn
 *   { type: 'file_change', agent, path, kind: 'create'|'update'|'delete'|'proposed' }
 *     — 'proposed' (story 008-001): a suggestion-mode write landed as a pending
 *       edit; the file's bytes are unchanged until the user accepts
 *   { type: 'citation', agent, key, bibtex, path } — add_citation upserted the bibliography (story 016)
 *   { type: 'question', agent, jobId, content } — ask_user is waiting; reply via POST /api/agent/jobs/:jobId/reply
 *   { type: 'question_expired', agent, jobId } — the pending question went unanswered at task teardown (no timeout); the agent proceeds with defaults (story 020)
 *   { type: 'notice', agent, jobId, reason: 'provider_overloaded', attempt, maxAttempts, nextRetryMs, message } — backing off on a transient API error before retrying (story 029)
 *   { type: 'done', agent, jobId, sessionId, usage: { inputTokens, outputTokens } }
 *   { type: 'error', agent, jobId, message, reason? } — reason 'provider_overloaded' on a terminal transient failure (story 029), 'budget_exceeded' on budget cutoff
 */
export async function* runAgentTask(task, internal = {}) {
  // Tee top-level runs into the per-project feed (story 005-001). Sub-agent
  // runs (depth > 0) are covered by dispatch_agent forwarding their events
  // into this (teed) parent channel — teeing both would double-publish.
  const topLevel = (internal.depth ?? 0) === 0;
  const state = {};
  const channel = new EventChannel(
    topLevel
      ? { onEvent: (event) => publishProjectEvent(task.projectId, event, { jobId: state.job?.id, userId: task.userId ?? null }) }
      : undefined,
  );
  Object.assign(state, {
    sdkQuery: null,
    finished: false,
    job: null,
    runHandle: null,
    // Detachable runs (the chat task path) survive a disconnect while parked
    // on a question, so a reconnect can resume them (story 027). Sub-agent and
    // seeding-pipeline runs are not detachable: they keep today's teardown.
    detachable: task.detachable === true,
  });

  const pump = runTask(task, internal, channel, state)
    .catch(async (err) => {
      console.error('[agent] Task failed:', err);
      // A transient model-provider failure that survived the runtime's retry
      // budget (story 029): tag it so the client offers a clean retry instead
      // of rendering a raw `API Error: 529` line, and hand back the session id
      // so a chat retry resumes this exact conversation.
      const transient = isTransientApiError(err);
      channel.push({
        type: 'error',
        agent: task.role,
        jobId: state.job?.id,
        message: transient
          ? 'The model provider is overloaded right now — a temporary upstream issue, not a problem with your project. Your work is saved; try again in a few seconds.'
          : err.message,
        ...(transient ? { reason: 'provider_overloaded', sessionId: state.sdkSessionId } : {}),
      });
      if (state.job) {
        await updateJob(state.job.id, { status: 'error', error: err.message }).catch(() => {});
      }
    })
    .finally(() => {
      state.finished = true;
      channel.end();
      unregisterRun(state.job?.id);
    });
  state.pump = pump;

  try {
    yield* consume(channel, task.signal);
  } finally {
    await teardownOrDetach(state);
  }
}

/**
 * Drain a channel, yielding events until it ends or the consumer's AbortSignal
 * fires. The signal is essential: when a run is parked on a question no events
 * arrive, so the for-await would block in channel.next() and a plain
 * generator.return() (from the SSE res 'close') could not run the teardown
 * finally until the await settled. Racing the signal ends the loop promptly so
 * teardownOrDetach runs at disconnect time (story 027).
 */
async function* consume(channel, signal) {
  while (true) {
    if (signal?.aborted) return;
    const r = await raceNext(channel, signal);
    if (r.aborted || r.done) return;
    yield r.value;
  }
}

function raceNext(channel, signal) {
  const next = channel.next();
  if (!signal) return next;
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    next.then(
      (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
      () => { signal.removeEventListener('abort', onAbort); resolve({ done: true }); },
    );
  });
}

/**
 * Decide what happens when a run's SSE consumer stops. A detachable run that
 * is currently parked on an ask_user question is left alive (its channel keeps
 * buffering) so POST /api/agent/jobs/:id/reconnect can resume it; every other
 * case interrupts the SDK loop and marks the job cancelled. A run that already
 * finished just settles its pump. (story 027)
 */
async function teardownOrDetach(state) {
  if (state.finished) {
    await state.pump;
    return;
  }
  const jobId = state.job?.id;
  if (state.detachable && jobId != null && hasPendingQuestion(jobId) && state.runHandle) {
    // Drop the abandoned channel waiter so events pushed after the user replies
    // are buffered for the reconnecting consumer instead of lost to a dead one.
    state.runHandle.channel.detach();
    state.runHandle.consumerAttached = false;
    return; // leave the run alive and parked; do NOT interrupt or await the pump
  }
  // Unblock ask_user first: the SDK loop may be parked inside its handler.
  if (jobId != null) cancelQuestion(jobId);
  try {
    await state.sdkQuery?.interrupt();
  } catch { /* already stopped */ }
  if (jobId != null) {
    await updateJob(jobId, { status: 'cancelled' }).catch(() => {});
  }
  await state.pump;
  unregisterRun(jobId);
}

/**
 * Re-attach a fresh SSE consumer to a still-alive run (story 027). Re-emits
 * the currently-pending question so the reconnecting UI can re-render its card,
 * then forwards live events. Shares runAgentTask's detach-vs-teardown finally,
 * so a second disconnect while still parked detaches again.
 *
 * @param {import('./runs.js').RunHandle} run
 * @param {AbortSignal} [signal] - fires when the reconnected consumer drops,
 *   so a second disconnect while still parked detaches promptly (story 027)
 */
export async function* reattach(run, signal) {
  try {
    const q = getPendingQuestion(run.jobId);
    if (q) yield { type: 'question', agent: q.agent ?? run.role, jobId: run.jobId, content: q.question };
    yield* consume(run.channel, signal);
  } finally {
    await teardownOrDetach(run.state);
  }
}

// Tools withheld in compose mode (story 017): `/write` asks the writer to
// return text only, so file mutation and bibliography upserts are removed from
// the allowlist. This is the runtime guarantee behind the "no file_change
// during /write" contract — the prompt asks, the tool filter enforces.
const COMPOSE_DENIED_TOOLS = new Set(['file_write', 'add_citation', 'add_reference', 'add_comment', 'manage_comments', 'project_config']);

async function runTask(task, internal, channel, state) {
  const { role, projectId, input, context = null, sessionId = null, compose = false, seeding = false, userId = null } = task;
  const depth = internal.depth ?? 0;
  const parentJobId = internal.parentJobId ?? null;
  const budget = internal.budget ?? { used: 0, limit: config.agent.tokenBudget };

  let agent = await getAgentWithTools(role);
  if (!agent) throw new Error(`Unknown agent role: ${role}`);
  if (compose) {
    agent = { ...agent, tools: agent.tools.filter((t) => !COMPOSE_DENIED_TOOLS.has(t)) };
  }

  // Weighted budget accounting (story 020): the budget is denominated in
  // root-agent-tier tokens, so a cheap sub-agent (Haiku RA) burns it slower
  // than the premium root (Opus PM). The root task pins the base weight.
  const modelWeight = modelCostWeight(agent.model ?? config.agent.model);
  budget.baseWeight ??= modelWeight;
  const costRatio = modelWeight / budget.baseWeight;

  const job = await createJob({ role: agent.slug, projectId, input, context, parentJobId, userId });
  state.job = job;
  if (depth === 0) {
    // Top-level job-start marker for the project feed (story 005-001); the
    // matching terminal 'done'/'error' flows through the channel tee.
    publishProjectEvent(projectId, { type: 'job', status: 'started', jobId: job.id, agent: agent.slug });
  }

  // Register detachable runs (the chat task path) so a reconnect can find the
  // live channel if the browser drops while parked on a question (story 027).
  if (state.detachable) {
    const handle = { jobId: job.id, projectId, role: agent.slug, channel, state, consumerAttached: true };
    registerRun(handle);
    state.runHandle = handle;
  }

  const conversation = await createConversation(agent.slug, projectId, userId);
  await updateJob(job.id, { status: 'running', conversationId: conversation.id });
  await logMessage({ conversationId: conversation.id, role: 'user', content: input, userId });

  const projectDir = await resolveProjectDir(projectId);

  // In-process MCP tools, filtered by the role's DB allowlist
  const mcpTools = buildMcpTools(agent, { projectId, depth, budget, parentJob: job, channel, userId, seeding });
  const mcpServer = mcpTools.length > 0
    ? createSdkMcpServer({ name: 'kuhn', version: '1.0.0', tools: mcpTools })
    : null;

  const builtinTools = agent.tools.flatMap((slug) => BUILTIN_TOOL_MAP[slug] ?? []);
  const allowedTools = [
    ...builtinTools,
    ...mcpTools.map((t) => `mcp__kuhn__${t.name}`),
  ];

  const usage = { inputTokens: 0, outputTokens: 0 };
  let sdkSessionId = sessionId;

  // Transient model-provider errors (529 Overloaded / 429 / 5xx) are upstream
  // and stateless: retry the SDK query with exponential backoff before giving
  // up, resuming the session so completed turns aren't re-run (story 029). The
  // SDK does its own shallow retries; this outer net survives a sustained
  // capacity event and narrates the wait to the client via a 'notice' event.
  // (A turn that half-streamed before the failure re-streams on resume — a rare
  // cosmetic doubling; the common case is a failure before any output.)
  const retry = config.agent.retry;
  for (let attempt = 0; ; attempt++) {
    try {
      await runSdkAttempt();
      return;
    } catch (err) {
      if (!isTransientApiError(err) || attempt >= retry.maxAttempts) throw err;
      const delay = backoffDelay(attempt + 1, retry);
      channel.push({
        type: 'notice',
        agent: agent.slug,
        jobId: job.id,
        reason: 'provider_overloaded',
        attempt: attempt + 1,
        maxAttempts: retry.maxAttempts,
        nextRetryMs: delay,
        message: `Model provider is busy (attempt ${attempt + 1}/${retry.maxAttempts}); retrying in ${Math.round(delay / 1000)}s…`,
      });
      await sleep(delay);
    }
  }

  async function runSdkAttempt() {
  const sdk = sdkQuery({
    prompt: buildPrompt(input, context),
    options: {
      systemPrompt: buildSystemPrompt(agent, projectDir),
      cwd: projectDir,
      // Per-agent model (story 021): each role runs on its DB-configured model
      // (sub-agents dispatched via dispatch_agent load their own row, so a
      // Haiku RA can serve an Opus PM); AGENT_MODEL is the global fallback.
      model: agent.model ?? config.agent.model,
      maxTurns: MAX_TURNS,
      tools: builtinTools,           // removes every built-in tool not granted to this role
      allowedTools,
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,  // token-level text_delta events for the chat UI (story 013)
      settingSources: [],            // never load host CLAUDE.md / settings into agent context
      ...(mcpServer ? { mcpServers: { kuhn: mcpServer } } : {}),
      // Resume the live session on retry so the agent continues from where the
      // transient failure interrupted it, not from scratch (story 029).
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    },
  });
  state.sdkQuery = sdk;

  for await (const message of sdk) {
    if (message.type === 'system' && message.subtype === 'init') {
      sdkSessionId = message.session_id;
      state.sdkSessionId = sdkSessionId;  // for resume on retry + terminal-error handoff (story 029)
      await updateJob(job.id, { sessionId: sdkSessionId });
      continue;
    }

    if (message.type === 'stream_event') {
      // Token-level streaming: forward text deltas as they arrive. The full
      // turn still follows as a single 'text' event (the chat UI replaces
      // accumulated deltas with it); logging/budgeting stay turn-based.
      const event = message.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        channel.push({ type: 'text_delta', agent: agent.slug, content: event.delta.text });
      }
      continue;
    }

    if (message.type === 'assistant') {
      const blocks = message.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use');

      await logMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: text || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        tokenCount: message.message?.usage?.output_tokens ?? null,
        userId,
      });

      if (text) channel.push({ type: 'text', agent: agent.slug, content: text });
      for (const call of toolCalls) {
        const fileEvent = fileChangeEvent(agent.slug, call, !seeding);
        if (fileEvent) channel.push(fileEvent);
      }

      const msgUsage = message.message?.usage;
      if (msgUsage) {
        const inputTokens = effectiveInputTokens(msgUsage);
        budget.used += (inputTokens + (msgUsage.output_tokens ?? 0)) * costRatio;
        usage.inputTokens += inputTokens;
        usage.outputTokens += msgUsage.output_tokens ?? 0;
      }
      // A grace margin lets an in-flight task overshoot the budget so the
      // current piece of work can finish instead of being cut off abruptly.
      if (budget.used > budget.limit * config.agent.budgetGrace) {
        await sdk.interrupt().catch(() => {});
        await updateJob(job.id, {
          status: 'error',
          error: 'token budget exceeded',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({
          type: 'error',
          agent: agent.slug,
          jobId: job.id,
          reason: 'budget_exceeded',
          // The SDK session is recorded so the client can resume this exact
          // conversation (with a fresh budget) instead of starting over.
          sessionId: sdkSessionId,
          message: `Token budget exceeded (${Math.round(budget.used)} > ${budget.limit} ${budget.baseWeight}×-weighted tokens). Task stopped.`,
          budget: { used: Math.round(budget.used), limit: budget.limit },
        });
        return;
      }
      continue;
    }

    if (message.type === 'user') {
      // Tool results echoed back into the loop
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_result') {
          await logMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            toolCallId: block.tool_use_id,
            userId,
            isError: block.is_error === true, // audit trail (issue #42)
          });
        }
      }
      continue;
    }

    if (message.type === 'result') {
      const resultUsage = message.usage ?? {};
      if (resultUsage.input_tokens != null) usage.inputTokens = effectiveInputTokens(resultUsage);
      if (resultUsage.output_tokens != null) usage.outputTokens = resultUsage.output_tokens;

      if (message.subtype === 'success') {
        await updateJob(job.id, {
          status: 'done',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({
          type: 'done', agent: agent.slug, jobId: job.id, sessionId: sdkSessionId, usage,
          budget: { used: Math.round(budget.used), limit: budget.limit },
        });
      } else {
        const reason = message.subtype.replace(/^error_/, '').replaceAll('_', ' ');
        await updateJob(job.id, {
          status: 'error',
          error: reason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        channel.push({
          type: 'error', agent: agent.slug, jobId: job.id, message: `Agent task stopped: ${reason}`,
          budget: { used: Math.round(budget.used), limit: budget.limit },
        });
      }
    }
  }
  }
}

// Transient model-provider errors (story 029): a 529 Overloaded, 429 rate-limit,
// 5xx, or a network blip is upstream and safe to retry. Classify by HTTP status
// when the SDK exposes one, else by the error text — the Agent SDK commonly
// surfaces these as `API Error: 529 Overloaded`.
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isTransientApiError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === 'number' && (TRANSIENT_STATUS.has(status) || status >= 500)) return true;
  const msg = `${err.message ?? err}`;
  return /\b(429|5\d\d|overloaded|rate[\s_-]?limit|too many requests)\b/i.test(msg)
    || /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up)\b/i.test(msg);
}

// Exponential backoff with full jitter, capped at retry.maxDelayMs (story 029).
function backoffDelay(attempt, { baseDelayMs, maxDelayMs }) {
  const ceil = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceil * (0.5 + Math.random() * 0.5));
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Approximate model price ratio for budget weighting (story 020), matched by
// substring of the model id ("claude-haiku-4-5" → weights.haiku).
function modelCostWeight(model) {
  const weights = config.agent.modelWeights;
  const id = (model ?? '').toLowerCase();
  for (const [key, weight] of Object.entries(weights)) {
    if (key !== 'default' && id.includes(key)) return weight;
  }
  return weights.default;
}

// Prompt-cache reads/writes are reported separately from input_tokens; count
// them all so budgets and job accounting reflect real context size.
function effectiveInputTokens(usage) {
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}

function buildSystemPrompt(agent, projectDir) {
  return [
    agent.system_prompt,
    '',
    '## Runtime environment',
    `You are running as the "${agent.slug}" agent inside the Kuhn writing tool.`,
    `Your project workspace is ${projectDir}.`,
    'Use the file tools (read_file, write_file, edit_file, list_files, search_files) for all',
    'file access; they take paths relative to the workspace root and cannot reach outside it.',
  ].join('\n');
}

function buildPrompt(input, context) {
  if (!context) return input;
  const parts = [input];
  if (context.selection) parts.push(`<selection>\n${context.selection}\n</selection>`);
  if (context.cursor?.line != null) parts.push(`The user's cursor is at line ${context.cursor.line}.`);
  if (context.files?.length) parts.push(`Relevant files: ${context.files.join(', ')}`);
  // `dir` (story 012-001) is the folder selected in the file panel. A default,
  // not a constraint: the agent still puts a file somewhere else when it plainly
  // belongs there. The client only ever sends a folder inside draft/ — see
  // webapp/src/chat.ts `draftTargetContext` for why that restriction exists.
  if (context.dir) parts.push(`Unless a file clearly belongs elsewhere, create new files in ${context.dir}/.`);
  return parts.join('\n\n');
}

// `suggesting` = suggestion mode is active for the task (i.e. not seeding);
// scoped write_file/edit_file calls then land as pending edits, so their live
// event is kind 'proposed' — badges update without an activity-log entry.
function fileChangeEvent(agentSlug, toolCall, suggesting = false) {
  const path = toolCall.input?.path;
  if (!path) return null;
  if (toolCall.name === 'mcp__kuhn__write_file') {
    const kind = suggesting && isSuggestionPath(path) ? 'proposed' : 'create';
    return { type: 'file_change', agent: agentSlug, path, kind };
  }
  if (toolCall.name === 'mcp__kuhn__edit_file') {
    const kind = suggesting && isSuggestionPath(path) ? 'proposed' : 'update';
    return { type: 'file_change', agent: agentSlug, path, kind };
  }
  return null;
}

function buildMcpTools(agent, { projectId, depth, budget, parentJob, channel, userId, seeding = false }) {
  const tools = [];

  // File tools (story 018): all project file access goes through the storage
  // service, which enforces the project root. Paths are workspace-relative.
  if (agent.tools.includes('file_read')) {
    tools.push(tool(
      'read_file',
      'Read a file from the project workspace. Path is relative to the workspace root.',
      { path: z.string().describe('Workspace-relative file path') },
      async ({ path }) => fileToolResult(async () => {
        // Suggestion-mode coherence (issue #42): if this path has a pending
        // proposal, show the proposed content — otherwise an agent that wrote
        // and reads back to verify sees stale disk bytes and concludes its
        // write was lost.
        if (!seeding && isSuggestionPath(path)) {
          const proposal = pendingProposalContent(projectId, path);
          if (proposal != null) {
            return `[${path} has a pending proposed update awaiting user review. The content below is the PROPOSED version; the file on disk keeps its previous content until the user accepts.]\n\n${proposal}`;
          }
        }
        const buf = await readProjectFile(projectId, path);
        return buf.toString('utf-8');
      }),
    ));
    tools.push(tool(
      'search_files',
      'Search project files for a regular expression. Returns matching lines as path:line: text.',
      {
        pattern: z.string().describe('JavaScript regular expression to search for'),
        path: z.string().default('.').describe('Workspace-relative directory to search in'),
      },
      async ({ pattern, path }) => fileToolResult(async () => {
        const matches = await searchProjectFiles(projectId, pattern, path);
        if (matches.length === 0) return 'No matches.';
        return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
      }),
    ));
  }

  if (agent.tools.includes('file_list')) {
    tools.push(tool(
      'list_files',
      'List the project workspace file tree.',
      { path: z.string().default('.').describe('Workspace-relative directory to list') },
      async ({ path }) => fileToolResult(async () => {
        const tree = await listProjectTree(projectId, path);
        return JSON.stringify(tree, null, 2);
      }),
    ));
  }

  if (agent.tools.includes('file_move')) {
    tools.push(tool(
      'move_file',
      'Move or rename a file or folder within the project workspace. Parent directories of the destination are created as needed. Use this to organize loose uploads — e.g. move "protocol.pdf" to "seed_docs/protocol.pdf".',
      {
        from: z.string().describe('Workspace-relative source path'),
        to: z.string().describe('Workspace-relative destination path (including the new filename)'),
      },
      async ({ from, to }) => fileToolResult(async () => {
        // Story 012-002: a move is an identity change, not a delete plus a
        // create. One 'moved' event carries the file's identity to the new
        // path and the hub re-keys every path-keyed consumer (seen state,
        // comments, pending edits, activeDocument) in the same transaction
        // that appends the activity row — so nothing is left orphaned at a
        // path that no longer exists.
        //
        // Pre-check the one collision the rewrite refuses, while the file is
        // still in place: a pending proposal at the destination exists only in
        // the DB (no bytes on disk), so storage cannot 409 on it and the
        // rewrite must not silently replace it.
        const clashes = findPendingEditConflicts(projectId, from, to);
        if (clashes.length > 0) {
          throw new Error(
            `Cannot move ${from} → ${to}: a pending proposed edit is already waiting at `
            + `${clashes.join(', ')}. Ask the user to accept or reject it first.`,
          );
        }
        // moveProjectEntry reports the CANONICAL paths it actually renamed;
        // publishing those (not the model's raw arguments) is what keeps the
        // prefix rewrite from matching zero rows on './a.md' or 'dir/'.
        const moved = await moveProjectEntry(projectId, from, to);
        const event = {
          type: 'file_change',
          agent: agent.slug,
          path: moved.to,
          kind: 'moved',
          meta: { from: moved.from },
        };
        // Published directly rather than only through the channel tee, because
        // 'moved' is the one kind whose persistence failure propagates and
        // EventChannel.push swallows tee throws (events.js:22-27) — a
        // push-only move would report success over a half-applied state. The
        // hub's WeakSet dedupe makes the tee's re-offer of this same object a
        // no-op, so the feed still sees exactly one envelope; it also means a
        // sub-agent run (depth > 0, untee'd) rewrites the DB too, where the
        // old push-only path depended on dispatch_agent forwarding.
        try {
          publishProjectEvent(projectId, event, { jobId: parentJob.id, userId });
        } catch (err) {
          // The rename already committed on disk. Put the bytes back so the
          // tool never reports a move whose consumers were not carried with it.
          let restored = true;
          try {
            await moveProjectEntry(projectId, moved.to, moved.from);
          } catch {
            restored = false;
          }
          throw new Error(
            `Move failed: ${err.message}. `
            + (restored
              ? `${moved.from} was left in place.`
              : `${moved.from} could NOT be restored and is now at ${moved.to} — tell the user.`),
          );
        }
        channel.push(event); // mirror into the live client stream (deduped above)
        return `Moved ${moved.from} → ${moved.to}`;
      }),
    ));
  }

  if (agent.tools.includes('file_write')) {
    tools.push(tool(
      'write_file',
      'Create or overwrite a file in the project workspace. Parent directories are created as needed.',
      {
        path: z.string().describe('Workspace-relative file path'),
        content: z.string().describe('Full file content'),
      },
      async ({ path, content }) => fileToolResult(async () => {
        await rejectDerivedBibWrite(projectId, path);
        // Suggestion mode (story 008-001): writes to draft/** become pending
        // edits the user reviews; the file's bytes do not change here. The
        // seeding pipeline bypasses the gate — its first draft writes land
        // directly (there is nothing to protect yet).
        if (!seeding && isSuggestionPath(path)) {
          await proposeEdit(projectId, { path, proposedContent: content, agentSlug: agent.slug, jobId: parentJob.id });
          return proposedResult(path);
        }
        const { created } = await writeProjectFile(projectId, path, content);
        return `${created ? 'Created' : 'Updated'} ${path}`;
      }),
    ));
    tools.push(tool(
      'edit_file',
      'Replace an exact string in a file. old_string must match exactly and, unless replace_all is true, exactly once.',
      {
        path: z.string().describe('Workspace-relative file path'),
        old_string: z.string().describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence'),
      },
      async ({ path, old_string, new_string, replace_all }) => fileToolResult(async () => {
        await rejectDerivedBibWrite(projectId, path);
        const suggesting = !seeding && isSuggestionPath(path);
        // In suggestion mode the "current content" is the EFFECTIVE content —
        // an existing proposal if there is one, else the disk file — so a
        // sequential write→edit on the same draft stays coherent (008-001).
        const content = suggesting
          ? await effectiveContent(projectId, path)
          : (await readProjectFile(projectId, path)).toString('utf-8');
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
        if (occurrences > 1 && !replace_all) {
          throw new Error(`old_string occurs ${occurrences} times in ${path}; pass replace_all or a longer unique string`);
        }
        const next = content.replaceAll(old_string, new_string);
        if (suggesting) {
          await proposeEdit(projectId, { path, proposedContent: next, agentSlug: agent.slug, jobId: parentJob.id });
          return proposedResult(path);
        }
        await writeProjectFile(projectId, path, next);
        return `Updated ${path} (${replace_all ? occurrences : 1} replacement${occurrences > 1 && replace_all ? 's' : ''})`;
      }),
    ));
  }

  if (agent.tools.includes('pubmed_search')) {
    tools.push(tool(
      'pubmed_search',
      'Search PubMed for peer-reviewed scientific papers. Call this whenever you need citations or evidence from the biomedical literature — never cite from memory.',
      {
        query: z.string().describe('Search query (keywords, MeSH terms, or author searches)'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
      },
      async ({ query, max_results }) => searchToolResult(() => pubmedSearch(query, max_results)),
    ));
  }

  if (agent.tools.includes('add_citation')) {
    tools.push(tool(
      'add_citation',
      'Add a citation to the project bibliography by PubMed ID. Verifies the metadata against PubMed, dedupes against existing entries, appends to the .bib file, and returns the BibTeX key to cite as [@key]. Find the PMID with pubmed_search first — never invent identifiers.',
      {
        pmid: z.string().describe('PubMed ID of the work to cite'),
        path: z.string().default(DEFAULT_BIB_PATH).describe('Workspace-relative .bib file path'),
      },
      async ({ pmid, path }) => {
        try {
          const { key, created, bibtex } = await upsertCitation(projectId, pmid, path);
          // Live citation event (deferred from story 011) so the editor can
          // refresh chips/bibliography without polling.
          channel.push({ type: 'citation', agent: agent.slug, key, bibtex, path });
          if (created) {
            channel.push({ type: 'file_change', agent: agent.slug, path, kind: 'update' });
          }
          return {
            content: [{
              type: 'text',
              text: created
                ? `Added to ${path} with key "${key}". Cite it as [@${key}].`
                : `Already in ${path} as "${key}". Cite it as [@${key}].`,
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `add_citation failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('add_reference')) {
    tools.push(tool(
      'add_reference',
      'Add a non-PubMed reference (preprint, government/regulatory doc, software, or other web source) to the project bibliography by full metadata. Dedupes against existing entries and returns the BibTeX key to cite as [@key]. Use add_citation for anything indexed in PubMed; use this for everything else. Never fabricate metadata — only add references your searches actually returned.',
      {
        title: z.string().describe('Title of the work'),
        authors: z.array(z.string()).describe('Author names, e.g. "Smith, Jane"'),
        year: z.number().int().optional().describe('Publication year'),
        entry_type: z.string().default('article').describe('BibTeX entry type (article, misc, techreport, ...)'),
        journal: z.string().optional().describe('Journal, venue, or publisher'),
        doi: z.string().optional().describe('DOI if available'),
        url: z.string().optional().describe('URL if available'),
        source_type: z.enum(['preprint', 'web', 'manual', 'government']).default('manual')
          .describe('Source authority class'),
        abstract: z.string().optional().describe('Abstract or summary'),
        path: z.string().default(DEFAULT_BIB_PATH).describe('Workspace-relative .bib file path'),
      },
      async ({ path, ...input }) => {
        try {
          const { key, created, bibtex } = await addReference(projectId, input, path);
          channel.push({ type: 'citation', agent: agent.slug, key, bibtex, path });
          if (created) {
            channel.push({ type: 'file_change', agent: agent.slug, path, kind: 'update' });
          }
          return {
            content: [{
              type: 'text',
              text: created
                ? `Added to ${path} with key "${key}". Cite it as [@${key}].`
                : `Already in ${path} as "${key}". Cite it as [@${key}].`,
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `add_reference failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('manage_references')) {
    // Deterministic corrections to the reference store (issue #41): the RA's
    // alternative to hand-editing the derived .bib, which the file tools
    // refuse. Both regenerate the bibliography file after changing the store.
    tools.push(tool(
      'update_reference',
      'Correct fields of an existing bibliography entry by its cite key (metadata fixes: title, authors, year, journal, DOI, pages, ...). Only the fields you pass change; the cite key never changes, so in-text [@key] citations keep working. The bibliography file is regenerated automatically. Never fabricate metadata — only apply corrections you verified against the source.',
      {
        cite_key: z.string().describe('Cite key of the entry to correct (as returned by add_citation/add_reference)'),
        title: z.string().optional().describe('Corrected title'),
        authors: z.array(z.string()).optional().describe('Corrected author list, e.g. "Smith, Jane"'),
        year: z.number().int().optional().describe('Corrected publication year'),
        journal: z.string().optional().describe('Corrected journal or venue'),
        volume: z.string().optional().describe('Corrected volume'),
        issue: z.string().optional().describe('Corrected issue'),
        pages: z.string().optional().describe('Corrected page range'),
        publisher: z.string().optional().describe('Corrected publisher'),
        doi: z.string().optional().describe('Corrected DOI'),
        pmid: z.string().optional().describe('Corrected PubMed ID'),
        url: z.string().optional().describe('Corrected URL'),
        entry_type: z.string().optional().describe('Corrected BibTeX entry type (article, misc, techreport, ...)'),
        source_type: z.enum(['pubmed', 'preprint', 'web', 'manual', 'government']).optional().describe('Corrected source authority class'),
        abstract: z.string().optional().describe('Corrected abstract'),
        path: z.string().default(DEFAULT_BIB_PATH).describe('Workspace-relative .bib file path'),
      },
      async ({ cite_key, path, entry_type, source_type, ...rest }) => {
        try {
          const changes = { ...rest };
          if (entry_type !== undefined) changes.entryType = entry_type;
          if (source_type !== undefined) changes.sourceType = source_type;
          const { key, bibtex } = await updateReference(projectId, cite_key, changes, path);
          channel.push({ type: 'citation', agent: agent.slug, key, bibtex, path });
          channel.push({ type: 'file_change', agent: agent.slug, path, kind: 'update' });
          return { content: [{ type: 'text', text: `Updated reference "${key}" and regenerated ${path}. Corrected entry:\n${bibtex}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `update_reference failed: ${err.message}` }], isError: true };
        }
      },
    ));
    tools.push(tool(
      'remove_reference',
      'Delete a bibliography entry by its cite key (e.g. a duplicate or a reference that could not be verified). The bibliography file is regenerated automatically. Check that the draft no longer cites [@key] before removing.',
      {
        cite_key: z.string().describe('Cite key of the entry to delete'),
        path: z.string().default(DEFAULT_BIB_PATH).describe('Workspace-relative .bib file path'),
      },
      async ({ cite_key, path }) => {
        try {
          const { key } = await removeReference(projectId, cite_key, path);
          channel.push({ type: 'file_change', agent: agent.slug, path, kind: 'update' });
          return { content: [{ type: 'text', text: `Removed reference "${key}" and regenerated ${path}.` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `remove_reference failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('add_comment')) {
    tools.push(tool(
      'add_comment',
      'File a margin comment on a passage of a project document. Quote the exact target text and the comment appears anchored to that passage in the editor, where the user and collaborators read, reply to, and resolve it. Use this for feedback on specific text instead of writing critique into chat or separate report files.',
      {
        path: z.string().describe('Workspace-relative path of the document'),
        quote: z.string().min(1).describe('The target text, copied VERBATIM from the current file content — a short excerpt (one clause to a few sentences) that pins down the passage'),
        body: z.string().min(1).describe('The comment: the issue, why it matters, and what needs to change'),
      },
      async ({ path, quote, body }) => {
        try {
          // Anchor against the stored bytes — what the user's editor shows.
          // A quote that no longer matches is the agent's error to fix.
          const content = (await readProjectFile(projectId, path)).toString('utf-8');
          const range = resolveQuote(content, quote);
          if (!range) {
            return {
              content: [{
                type: 'text',
                text: `add_comment failed: the quote was not found in ${path}. Re-read the file and copy the target text exactly as it appears now.`,
              }],
              isError: true,
            };
          }
          const thread = createThread(projectId, {
            path,
            body,
            quote: content.slice(range.start, range.end),
            start: range.start,
            end: range.end,
            userId,
            agentSlug: agent.slug,
            jobId: parentJob.id,
          });
          channel.push({
            type: 'comment', action: 'create', agent: agent.slug,
            path, id: thread.id, rootId: thread.id,
          });
          return { content: [{ type: 'text', text: `Comment filed on ${path} (comment ${thread.id}).` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `add_comment failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('manage_comments')) {
    // Issue #58: the read-and-act half of the comment loop. add_comment can
    // file feedback, but agents could not see existing threads (from users,
    // external reviewers, or other agents), answer them, or close them out.
    // Resolution stamps the task's user (agents act on the user's behalf);
    // in-thread attribution comes from the agent-authored reply.
    const author = (c) => {
      if (c.agent) return `${c.agent} (agent)`;
      if (c.userName) return c.userName;
      if (c.reviewerName) return `${c.reviewerName} (external reviewer)`;
      return 'unknown';
    };
    tools.push(tool(
      'list_comments',
      'List margin-comment threads on a document (or the whole project): who wrote each comment, the anchored quote, the full thread of replies, and its open/resolved state. Use this before filing comments (avoid duplicates), when asked to address feedback, and to find threads to resolve.',
      {
        path: z.string().optional().describe('Workspace-relative document path; omit to list threads across the whole project'),
        include_resolved: z.boolean().default(false).describe('Include threads that are already resolved (default: open threads only)'),
      },
      async ({ path, include_resolved }) => {
        try {
          let threads = listThreads(projectId, { path: path ?? null });
          if (!include_resolved) threads = threads.filter((t) => t.resolvedAt == null);
          if (threads.length === 0) {
            const scope = path ? `on ${path}` : 'in this project';
            return { content: [{ type: 'text', text: `No ${include_resolved ? '' : 'open '}comment threads ${scope}.` }] };
          }
          const text = threads.map((t) => {
            const status = t.resolvedAt ? 'resolved' : 'open';
            const anchor = t.anchor?.quote
              ? `\n  anchored to: "${t.anchor.quote}"${t.orphaned ? ' (orphaned — the quoted text no longer exists)' : ''}`
              : '';
            const replies = t.replies.map((r) => `\n  ↳ ${author(r)}: ${r.body}`).join('');
            return `Comment ${t.id} on ${t.path} [${status}] by ${author(t)}:${anchor}\n  ${t.body}${replies}`;
          }).join('\n\n');
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `list_comments failed: ${err.message}` }], isError: true };
        }
      },
    ));
    tools.push(tool(
      'reply_comment',
      'Reply in an existing comment thread. Use it to answer a question asked in a comment, or to explain what you changed in response. The reply appears in the thread in the editor, attributed to you.',
      {
        comment_id: z.number().int().describe('Thread id (the root comment id from list_comments)'),
        body: z.string().min(1).describe('The reply text'),
      },
      async ({ comment_id, body }) => {
        try {
          const reply = addReply(projectId, comment_id, {
            body, userId, agentSlug: agent.slug, jobId: parentJob.id,
          });
          channel.push({
            type: 'comment', action: 'reply', agent: agent.slug,
            path: reply.path, id: reply.id, rootId: comment_id,
          });
          return { content: [{ type: 'text', text: `Reply added to comment ${comment_id} on ${reply.path}.` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `reply_comment failed: ${err.message}` }], isError: true };
        }
      },
    ));
    tools.push(tool(
      'resolve_comment',
      'Resolve a comment thread after its concern has been fully addressed. Pass a note saying what was done — it is filed as your reply in the thread before resolving, so the resolution is traceable. Only resolve threads you (or the change you just made) actually addressed; leave open questions for the user.',
      {
        comment_id: z.number().int().describe('Thread id (the root comment id from list_comments)'),
        note: z.string().optional().describe('What was changed or why the comment is settled — filed as a closing reply in the thread'),
      },
      async ({ comment_id, note }) => {
        try {
          if (note && note.trim().length > 0) {
            const reply = addReply(projectId, comment_id, {
              body: note.trim(), userId, agentSlug: agent.slug, jobId: parentJob.id,
            });
            channel.push({
              type: 'comment', action: 'reply', agent: agent.slug,
              path: reply.path, id: reply.id, rootId: comment_id,
            });
          }
          const thread = setResolved(projectId, comment_id, true, { userId });
          channel.push({
            type: 'comment', action: 'resolve', agent: agent.slug,
            path: thread.path, id: comment_id, rootId: comment_id,
          });
          return { content: [{ type: 'text', text: `Resolved comment ${comment_id} on ${thread.path}.` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `resolve_comment failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('arxiv_search')) {
    tools.push(tool(
      'arxiv_search',
      'Search arXiv for preprints. Flag any preprint citations as needing verification of peer-reviewed publication status.',
      {
        query: z.string().describe('Search query'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
      },
      async ({ query, max_results }) => searchToolResult(() => arxivSearch(query, max_results)),
    ));
  }

  if (agent.tools.includes('search_org_knowledge')) {
    // The one sanctioned crossing of the project-root boundary (story 006-003):
    // read-only passages from the org's knowledge library, with provenance. The
    // org is derived server-side from the task's project — agents never pick
    // their tenant, so there is deliberately no org parameter.
    tools.push(tool(
      'search_org_knowledge',
      'Search your organization\'s shared knowledge library (style guides, SOPs, regulatory guidance, templates, prior work) for relevant passages. Returns ranked excerpts, each with the source document and section — cite the source document by name when you rely on one. Read-only and org-wide; separate from this project\'s files.',
      {
        query: z.string().describe('Full-text keyword query (plain domain terms work best)'),
        limit: z.number().int().min(1).max(25).default(8).describe('Maximum passages to return'),
      },
      async ({ query, limit }) => {
        try {
          const project = await getProject(projectId);
          const orgId = project?.org_id;
          if (orgId == null || !hasReadyOrgDocuments(orgId)) {
            return {
              content: [{
                type: 'text',
                text: 'The organization has no library documents yet. Proceed without org guidance — do not retry this search.',
              }],
            };
          }
          const passages = searchOrgKnowledge(orgId, query, limit);
          if (passages.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No org library passages matched "${query}". Try once more with different keywords, or proceed without org guidance.`,
              }],
            };
          }
          const text = passages.map((p, i) => {
            const doc = p.title || p.filename;
            const section = p.headingPath ? ` — section: ${p.headingPath}` : '';
            return `${i + 1}. Source: "${doc}" (${p.filename})${section}\n${p.snippet}`;
          }).join('\n\n');
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `search_org_knowledge failed: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('ask_user')) {
    tools.push(tool(
      'ask_user',
      'Ask the user a question and wait for their reply. Use this for interview questions and any decision that needs user input. Ask one question at a time and adapt to earlier answers.',
      { question: z.string().describe('The question to show the user') },
      async ({ question }) => {
        // The reply round-trip (story 012): emit a question event carrying the
        // job id, then park until POST /api/agent/jobs/:id/reply delivers the
        // answer (or the timeout / task teardown unblocks us without one).
        channel.push({ type: 'question', agent: agent.slug, jobId: parentJob.id, content: question });
        const reply = await waitForReply(parentJob.id, config.agent.questionTimeoutMs, { question, agent: agent.slug });
        if (reply == null) {
          // Tell the webapp the question is no longer answerable (story 020);
          // on task teardown the channel is already closed and this is a no-op.
          channel.push({ type: 'question_expired', agent: agent.slug, jobId: parentJob.id });
          return {
            content: [{
              type: 'text',
              text: '[No reply received. Do not wait further: continue with sensible defaults and clearly note any assumptions you make.]',
            }],
          };
        }
        return { content: [{ type: 'text', text: reply }] };
      },
    ));
  }

  if (agent.tools.includes('project_config')) {
    tools.push(tool(
      'save_project_config',
      'Save the structured project configuration (type, config) to the project record and write project.json to the workspace root. The project keeps the name the user gave it; the title here is stored as metadata. Normally handled by the setup wizard before this agent runs — retained for edge cases where the config still needs to be saved or updated from here.',
      {
        title: z.string().describe('Project title'),
        project_type: z.enum(['rwe-protocol', 'rct-protocol', 'grant', 'manuscript', 'sop'])
          .describe('Document type; pick the closest match for "other" projects'),
        research_question: z.string().describe('The central research question or document purpose'),
        deliverables: z.array(z.string()).min(1).describe('Key deliverables'),
        timeline: z.string().describe('Key milestones and dates (use absolute dates)'),
        source_materials: z.array(z.string()).default([])
          .describe('Source materials the user already has (guidance docs, prior protocols, key papers, data)'),
        notes: z.string().optional().describe('Anything else from the interview worth preserving'),
      },
      async (input) => {
        try {
          const projectConfig = {
            title: input.title,
            project_type: input.project_type,
            research_question: input.research_question,
            deliverables: input.deliverables,
            timeline: input.timeline,
            source_materials: input.source_materials ?? [],
            ...(input.notes ? { notes: input.notes } : {}),
          };
          // Keep the user's chosen project name; the manuscript title lives in
          // config.title (and the user can rename the project explicitly).
          const { created } = await applyProjectConfig(projectId, projectConfig);
          channel.push({
            type: 'file_change',
            agent: agent.slug,
            path: 'project.json',
            kind: created ? 'create' : 'update',
          });
          return { content: [{ type: 'text', text: 'Project configuration saved to the project record and project.json.' }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to save project config: ${err.message}` }], isError: true };
        }
      },
    ));
  }

  if (agent.tools.includes('spawn_agent') && depth < config.agent.maxDispatchDepth) {
    tools.push(tool(
      'dispatch_agent',
      'Dispatch a sub-agent to perform a focused task (e.g. ra for literature research, advisor for domain review). Returns the sub-agent\'s final output.',
      {
        agent_slug: z.string().describe('Agent to dispatch: pm, writer, ra, advisor, reviewer, analyst'),
        task: z.string().describe('Task description for the sub-agent'),
        context: z.string().optional().describe('Additional context for the sub-agent'),
      },
      async ({ agent_slug, task, context }) => {
        const input = context ? `${task}\n\nContext: ${context}` : task;
        let finalText = '';
        let errorMessage = null;
        const child = runAgentTask(
          // Sub-jobs inherit the dispatching user's attribution (story 007-001)
          // and the seeding bypass (story 008-001): a sub-agent dispatched by a
          // seeding stage writes the first draft directly too.
          { role: agent_slug, projectId, input, userId, seeding },
          { depth: depth + 1, parentJobId: parentJob.id, budget },
        );
        for await (const event of child) {
          if (event.type === 'text') finalText += (finalText ? '\n' : '') + event.content;
          if (event.type === 'error') errorMessage = event.message;
          // Forward child progress to the client; the parent emits the single
          // terminal 'done' for the whole task.
          if (event.type !== 'done') channel.push(event);
        }
        if (errorMessage) {
          return { content: [{ type: 'text', text: `Sub-agent failed: ${errorMessage}` }], isError: true };
        }
        return { content: [{ type: 'text', text: finalText || '(sub-agent produced no output)' }] };
      },
    ));
  }

  return tools;
}

async function searchToolResult(fn) {
  try {
    const results = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true };
  }
}

// The suggestion-mode success message (issue #42): agents treated the old
// "awaiting user review" phrasing as a failed/blocked write and thrashed —
// retrying, rewriting whole files, or declaring the tool broken. Say outright
// that the write succeeded and is complete.
function proposedResult(path) {
  return `Successfully proposed update to ${path}. The write is COMPLETE — do not retry or rewrite. `
    + 'It is recorded as a pending suggestion the user reviews in the editor; the file on disk changes only when they accept. '
    + 'Reading the file back will show your proposed version.';
}

// Refuse direct writes to a materialized bibliography (issue #42): the file is
// derived from the reference store, so a hand edit is clobbered on the next
// regeneration — and under suggestion mode it would sit as an invisible
// pending edit. Steer to the deterministic reference tools instead.
async function rejectDerivedBibWrite(projectId, path) {
  if (await isDerivedBibPath(projectId, path)) {
    throw new Error(
      `${path} is generated from the project reference store; direct edits are overwritten the next time the bibliography is regenerated. `
      + 'Use add_citation (PubMed works) or add_reference (everything else) to add entries, and '
      + 'update_reference / remove_reference to correct or delete existing ones. If you lack those '
      + 'tools, dispatch the ra agent or tell the user exactly what needs to change.',
    );
  }
}

async function fileToolResult(fn) {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}
