// The agent-task boundary. The rest of the system depends only on
// runAgentTask(); model providers sit below it as AgentRuntime adapters.
//
// STH-1: the model-callable Kuhn tools are described once in provider-neutral
// form (agents/tools/); the Claude tool adapter (provider-runtime/
// claude-tools.js) is the only code that turns them into SDK/MCP form.
// STH-7: the Claude AgentRuntime adapter (provider-runtime/claude-runtime.js)
// is the production model-execution boundary — model execution, streaming,
// tool-loop mechanics, provider errors/identity, usage, canonical
// continuation, and cancellation all live there. This module owns the Kuhn
// product semantics: jobs, conversations, retries/backoff, budgets,
// questions/reconnect, sub-agent policy, storage/product effects, and event
// publication. Outside the Claude adapter, production code neither imports
// Claude SDK objects nor understands Claude message shapes.

import { config } from '../config.js';
import { getAgentWithTools } from '../db/agents.js';
import { createConversation, logMessage } from '../db/conversation.js';
import { createJob, updateJob } from '../db/jobs.js';
import { getProject } from '../db/projects.js';
import { getOrgAgentPrompt } from '../db/org-agent-prompts.js';
import { resolveProjectDir } from '../storage.js';
import { publishProjectEvent } from '../project-events.js';
import { EventChannel } from './events.js';
import { cancelQuestion, hasPendingQuestion, getPendingQuestion } from './questions.js';
import { registerRun, unregisterRun } from './runs.js';
import { createToolContext, listTools } from './tools/index.js';
import { createAgentRuntime } from './provider-runtime/factory.js';
import { PROVIDER_ERROR_CODES, normalizeProviderError } from './provider-runtime/contract.js';

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
 * @param {object} [task.context] - Optional editor context: { selection, cursor: {line},
 *   files, dir, activeDocument }. `activeDocument` (STH-43) is the path the user
 *   has open in the editor; when absent (and not seeding) it falls back to the
 *   project's persisted last-open document, and sub-agent dispatches inherit it.
 * @param {string} [task.sessionId] - Continue a prior provider session
 * @param {object} [task.continuation] - Canonical Kuhn continuation (STH-47)
 *   to resume from: the provider-neutral record of a prior run (a follow-up
 *   task). Runtimes without provider-side sessions (Pi) resume the model
 *   context from this record.
 * @param {boolean} [task.compose] - Compose mode (story 017): withhold file-mutating
 *   tools so the agent returns text only and emits no file_change (the /write contract)
 * @param {boolean} [task.seeding] - Seeding-pipeline bypass (story 008-001):
 *   suggestion mode normally turns agent writes to draft/** (and to existing
 *   files elsewhere, STH-44) into pending edits;
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
 *   { type: 'notice', agent, jobId, reason: 'provider_overloaded', attempt, maxAttempts, nextRetryMs, message } — backing off on a transient provider error before retrying (story 029)
 *   { type: 'done', agent, jobId, sessionId, usage: { inputTokens, outputTokens }, continuation } — continuation is the canonical record (STH-47) a follow-up task can resume
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
    runtime: null,
    controller: null,
    finished: false,
    job: null,
    runHandle: null,
    // Opaque provider session handle (Claude session id): updated from the
    // runtime's provider events, used for retry-resume and terminal-error
    // handoff. Kuhn treats it as an opaque string.
    sessionId: task.sessionId ?? null,
    // Canonical Kuhn continuation threaded across attempts (STH-7).
    // Seeded from the caller for follow-up tasks (STH-47): a prior run's
    // provider-neutral record the adapters resume instead of starting cold.
    continuation: task.continuation ?? null,
    // 'budget' when the budget cutoff aborts the in-flight turn; 'disconnect'
    // when the consumer dropped; null while the run is healthy.
    cancelReason: null,
    // Detachable runs (the chat task path) survive a disconnect while parked
    // on a question, so a reconnect can resume them (story 027). Sub-agent and
    // seeding-pipeline runs are not detachable: they keep today's teardown.
    detachable: task.detachable === true,
  });

  const pump = runTask(task, internal, channel, state)
    .catch(async (err) => {
      console.error('[agent] Task failed:', err);
      // Provider failures no longer throw — the runtime adapter surfaces
      // them as its terminal `error` event (with the retry/notice handling
      // in runTask). Anything that escapes here is a non-provider failure
      // (DB, unknown role, …) and is reported raw.
      channel.push({
        type: 'error',
        agent: task.role,
        jobId: state.job?.id,
        message: err.message,
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
 * case interrupts the in-flight turn through the runtime adapter and marks
 * the job cancelled. A run that already finished just settles its pump.
 * (story 027)
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
  // Unblock ask_user first: the runtime loop may be parked inside its handler.
  if (jobId != null) cancelQuestion(jobId);
  if (!state.cancelReason) state.cancelReason = 'disconnect';
  state.controller?.abort(); // the adapter interrupts the provider query
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

// The story-029 terminal message for a transient provider failure that
// survived the retry budget: a clean, non-technical explanation plus a
// retry affordance, instead of a raw `API Error: 529` line.
const OVERLOADED_TERMINAL_MESSAGE =
  'The model provider is overloaded right now — a temporary upstream issue, not a problem with your project. Your work is saved; try again in a few seconds.';

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

  // Org-wide prompt addition (issue #67): owner-set guardrail text appended
  // to this agent's system prompt. Resolved once per task; sub-agent
  // dispatches recurse through runTask with the same projectId, so the
  // addition reaches them without any plumbing.
  const project = await getProject(projectId);
  const orgAddition = project?.org_id
    ? getOrgAgentPrompt(project.org_id, agent.slug)?.addition ?? null
    : null;

  // Which document the user is looking at (STH-43). The chat client sends it
  // with every turn; other callers (check scripts, the REST route without
  // context) fall back to the project's persisted last-open document, which
  // is the same thing the browser shows. Seeding runs are left alone — there
  // is no user looking at anything yet, and their prompts are fixed.
  const taskContext = seeding ? context : withActiveDocument(context, project);

  // Neutral Kuhn tool registry (STH-1): the model-callable surface, derived
  // server-side from the role's DB grants and the task context. The Claude
  // adapter below projects it into MCP form; no Claude name or type leaks
  // past provider-runtime/.
  const toolContext = createToolContext({
    agent, projectId, depth, budget, parentJob: job, channel, userId, seeding,
    context: taskContext,
    dispatch: (t, i) => runAgentTask(t, i),
  });
  const neutralTools = listTools(toolContext);

  // The model-execution boundary (STH-7/STH-8): the provider adapter
  // selected by the deployment (STH-47: KUHN_AGENT_RUNTIME — claude
  // default, pi opt-in) owns model execution, streaming, tool-loop
  // mechanics, provider errors/identity, usage, canonical continuation,
  // and cancellation. This module consumes the normalized contract only.
  const runtime = createAgentRuntime({
    // Per-agent model (story 021): each role runs on its DB-configured model
    // (sub-agents dispatched via dispatch_agent load their own row, so a
    // Haiku RA can serve an Opus PM); AGENT_MODEL is the global fallback.
    model: agent.model ?? config.agent.model,
    projectDir,
    tools: neutralTools,
    maxTurns: MAX_TURNS,
    initialSessionId: sessionId,
  });
  state.runtime = runtime;
  state.controller = new AbortController();

  const systemPrompt = buildSystemPrompt(agent, projectDir, orgAddition);
  const prompt = buildPrompt(input, taskContext);

  // Product-side usage in effective (budget/job) terms; the runtime's
  // canonical usage is disjoint-component and is converted per turn.
  const usage = { inputTokens: 0, outputTokens: 0 };

  // Effective runtime identity (STH-47): the provider/model that actually
  // ran the job, stamped at the job terminal so a continuation or retry can
  // never silently switch mechanics.
  const jobIdentity = () => ({
    provider: runtime.identity?.provider ?? null,
    model: runtime.identity?.model ?? null,
  });

  // Transient provider failures (rate limit / overload / 5xx / network) are
  // upstream and stateless: retry the turn with exponential backoff before
  // giving up, resuming the session so completed turns aren't re-run
  // (story 029). The adapter normalizes provider errors; the retry policy,
  // the client-facing 'notice', and the session bookkeeping are Kuhn's.
  // (A turn that half-streamed before the failure re-streams on resume — a
  // rare cosmetic doubling; the common case is a failure before any output.)
  const retry = config.agent.retry;
  for (let attempt = 0; ; attempt++) {
    const outcome = await runTurnLoop(runtime, {
      input: prompt,
      systemPrompt,
      signal: state.controller.signal,
      resume: state.sessionId,
      continuation: state.continuation,
      // The product's explicit retry flag (STH-47): attempts after the
      // first retry the same logical request over the failed attempt's
      // canonical record — the adapters must not re-append its input.
      retry: attempt > 0,
    }, { agent, job, conversation, channel, budget, costRatio, usage, userId, state });

    if (outcome.kind === 'done') {
      if (outcome.continuation) state.continuation = outcome.continuation;
      if (state.controller?.signal.aborted) {
        // The product aborted this turn (budget cutoff or consumer
        // disconnect) and the adapter's done terminal raced the abort
        // (the final message completed before the abort landed). The
        // abort wins: the job already carries the abort status and the
        // client already got the abort event — a done terminal would
        // overwrite both.
        return;
      }
      const doneUsage = outcome.usage ?? {};
      const productUsage = {
        inputTokens: effectiveInputTokens(doneUsage),
        outputTokens: doneUsage.outputTokens ?? usage.outputTokens,
      };
      await updateJob(job.id, {
        status: 'done',
        inputTokens: productUsage.inputTokens,
        outputTokens: productUsage.outputTokens,
        ...jobIdentity(),
        // Persist the canonical record so a follow-up (and a rollback to
        // another runtime) can resume provider-neutrally (STH-47).
        continuation: state.continuation ?? null,
      });
      channel.push({
        type: 'done', agent: agent.slug, jobId: job.id, sessionId: state.sessionId,
        usage: productUsage,
        budget: { used: Math.round(budget.used), limit: budget.limit },
        continuation: state.continuation ?? null,
      });
      return;
    }

    const perr = outcome.error;
    if (outcome.continuation) state.continuation = outcome.continuation;

    if (perr.code === 'cancelled') {
      // The budget cutoff already pushed its own error event; the disconnect
      // teardown marked the job cancelled. The run is over.
      return;
    }

    if (perr.retryable && attempt < retry.maxAttempts) {
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
      continue; // next attempt resumes state.sessionId
    }

    // Terminal failure. Provider failures (the PROVIDER_ERROR_CODES
    // vocabulary) keep the provider's own message; the retryable ones that
    // exhausted the budget get the story-029 friendly explanation. Turn
    // terminations (max_turns, …) render as "Agent task stopped: <reason>".
    const providerFailure = PROVIDER_ERROR_CODES.has(perr.code);
    const reason = providerFailure ? perr.message : perr.code.replaceAll('_', ' ');
    const message = perr.retryable
      ? OVERLOADED_TERMINAL_MESSAGE
      : (providerFailure ? perr.message : `Agent task stopped: ${reason}`);
    const jobTokens = outcome.usage
      ? {
          inputTokens: effectiveInputTokens(outcome.usage),
          outputTokens: outcome.usage.outputTokens ?? usage.outputTokens,
        }
      : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    await updateJob(job.id, {
      status: 'error',
      error: reason,
      inputTokens: jobTokens.inputTokens,
      outputTokens: jobTokens.outputTokens,
      ...jobIdentity(),
    });
    channel.push({
      type: 'error', agent: agent.slug, jobId: job.id, message,
      ...(perr.retryable ? { reason: 'provider_overloaded', sessionId: state.sessionId } : {}),
      budget: { used: Math.round(budget.used), limit: budget.limit },
    });
    return;
  }

  /**
   * Consume one runtime turn, mapping the normalized runtime events onto the
   * product surface: the event channel (text_delta/text), the conversation
   * log (assistant rows + tool rows), and budget enforcement.
   *
   * @returns {Promise<{kind: 'done', usage: object} | {kind: 'error', error: object, usage: object|null, continuation: object|null}>}
   */
  async function runTurnLoop(runtime, turn, refs) {
    const { agent, job, conversation, channel, budget, costRatio, usage, userId, state } = refs;

    // Assistant-turn state for the conversation log. The assistant row is
    // written when the turn's usage event arrives — by then the full
    // assistant message (text + tool calls) is known — which preserves the
    // pre-seam DB row order (the assistant row before its tool rows). A turn
    // without a usage event is closed at the terminal.
    const turnLog = { open: false, text: null, calls: [], tokenCount: null };
    // Assistant logging is awaited at every close site: a DB/logging
    // failure must not silently coexist with a successfully completed job
    // (STH-47 review). It still lands in the historical row order — the
    // assistant row is written before its tool rows.
    const closeTurn = async () => {
      if (!turnLog.open) return;
      await logMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: turnLog.text,
        toolCalls: turnLog.calls.length > 0 ? turnLog.calls : null,
        tokenCount: turnLog.tokenCount,
        userId,
      });
      turnLog.open = false;
      turnLog.text = null;
      turnLog.calls = [];
      turnLog.tokenCount = null;
    };

    for await (const event of runtime.runTurn(turn)) {
      switch (event.type) {
        case 'provider': {
          if (event.sessionId && event.sessionId !== state.sessionId) {
            state.sessionId = event.sessionId;
            // Record the session so a retry resumes it and a terminal
            // transient error can hand it back to a chat retry (story 029).
            updateJob(job.id, { sessionId: event.sessionId }).catch(() => {});
          }
          break;
        }
        case 'text_delta':
          channel.push({ type: 'text_delta', agent: agent.slug, content: event.content });
          break;
        case 'text':
          // The full turn still follows the token-level deltas as a single
          // 'text' event (the chat UI replaces accumulated deltas with it).
          if (!turnLog.open) turnLog.open = true;
          turnLog.text = event.content;
          channel.push({ type: 'text', agent: agent.slug, content: event.content });
          break;
        case 'tool_call':
          // File events for write_file/edit_file are pushed by the tool
          // executors themselves (STH-44) — they alone know whether a write
          // landed on disk or as a proposal, and a failed write emits nothing.
          turnLog.open = true;
          turnLog.calls.push({ id: event.id, name: event.name, input: event.arguments ?? {} });
          break;
        case 'usage': {
          const u = event.usage;
          const effectiveIn = effectiveInputTokens(u);
          const out = u.outputTokens ?? 0;
          budget.used += (effectiveIn + out) * costRatio;
          usage.inputTokens += effectiveIn;
          usage.outputTokens += out;
          turnLog.tokenCount = u.outputTokens ?? null;
          await closeTurn();
          // A grace margin lets an in-flight task overshoot the budget so the
          // current piece of work can finish instead of being cut off
          // abruptly.
          if (budget.used > budget.limit * config.agent.budgetGrace) {
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
              // The provider session is recorded so the client can resume
              // this exact conversation (with a fresh budget) instead of
              // starting over.
              sessionId: state.sessionId,
              message: `Token budget exceeded (${Math.round(budget.used)} > ${budget.limit} ${budget.baseWeight}×-weighted tokens). Task stopped.`,
              budget: { used: Math.round(budget.used), limit: budget.limit },
            });
            state.controller.abort();
          }
          break;
        }
        case 'tool_result':
          // Tool results echoed back into the loop.
          await logMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: event.content?.[0]?.text ?? '',
            toolCallId: event.id,
            userId,
            isError: event.isError === true, // audit trail (issue #42)
          });
          break;
        case 'done':
          await closeTurn();
          return { kind: 'done', usage: event.usage, continuation: event.continuation ?? null };
        case 'error':
          await closeTurn();
          return { kind: 'error', error: event.error, usage: event.usage ?? null, continuation: event.continuation ?? null };
        default:
          break;
      }
    }
    // The runtime is contractually obliged to end with exactly one terminal
    // event; a stream that ends without one is a contract violation.
    await closeTurn();
    return {
      kind: 'error',
      error: normalizeProviderError(new Error('agent runtime stream ended without a terminal event')),
      usage: null,
      continuation: state.continuation,
    };
  }
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

// Product accounting (story 020): budgets and job figures count cached input
// as input. The canonical runtime usage keeps the cache components disjoint,
// so fold them in here.
function effectiveInputTokens(usage) {
  return (usage?.inputTokens ?? 0)
    + (usage?.cacheReadTokens ?? 0)
    + (usage?.cacheWriteTokens ?? 0);
}

function buildSystemPrompt(agent, projectDir, orgAddition = null) {
  const parts = [
    agent.system_prompt,
    '',
    '## Runtime environment',
    `You are running as the "${agent.slug}" agent inside the Kuhn writing tool.`,
    `Your project workspace is ${projectDir}.`,
    'Use the file tools (read_file, write_file, edit_file, list_files, search_files) for all',
    'file access; they take paths relative to the workspace root and cannot reach outside it.',
  ];
  // Issue #67: org-owner guardrails go AFTER the runtime block so they can
  // never shadow the tool contract, and are framed as policy on top of the
  // role — they may restrict, never expand, what the agent can do.
  if (orgAddition) {
    parts.push(
      '',
      '## Organization guardrails (set by your organization)',
      'Your organization added the following instructions for this agent. They',
      'supplement your role instructions; where they impose stricter limits,',
      'follow the stricter rule. They cannot grant tools or access you do not',
      'already have.',
      '',
      orgAddition,
    );
  }
  return parts.join('\n');
}

/** Fill in `activeDocument` from the project's persisted last-open document
 * when the caller did not say which file the user is looking at (STH-43). */
function withActiveDocument(context, project) {
  if (context?.activeDocument) return context;
  const persisted = project?.config?.activeDocument;
  if (typeof persisted !== 'string' || !persisted) return context;
  return { ...(context ?? {}), activeDocument: persisted };
}

function buildPrompt(input, context) {
  if (!context) return input;
  const parts = [input];
  if (context.selection) parts.push(`<selection>\n${context.selection}\n</selection>`);
  if (context.cursor?.line != null) parts.push(`The user's cursor is at line ${context.cursor.line}.`);
  if (context.files?.length) parts.push(`Relevant files: ${context.files.join(', ')}`);
  // The open document (STH-43): "the doc" means what the user is looking at,
  // not draft/main.md by default — early in a project main.md is often still
  // empty while the real work (a lit review, an outline) lives elsewhere.
  if (context.activeDocument) {
    parts.push(
      `The user currently has ${context.activeDocument} open in the editor. When they refer to `
      + '"the doc", "this document", "the draft" or similar without naming a file, they mean this one — '
      + 'do not assume draft/main.md. Name this path explicitly in any task you dispatch to another agent. '
      + 'If it is genuinely ambiguous which document they mean, ask before acting.',
    );
  }
  // `dir` (story 012-001) is the folder selected in the file panel. A default,
  // not a constraint: the agent still puts a file somewhere else when it plainly
  // belongs there. The client only ever sends a folder inside draft/ — see
  // webapp/src/chat.ts `draftTargetContext` for why that restriction exists.
  if (context.dir) parts.push(`Unless a file clearly belongs elsewhere, create new files in ${context.dir}/.`);
  return parts.join('\n\n');
}
