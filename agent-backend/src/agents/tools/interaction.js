/**
 * Kuhn interaction tools (STH-1): ask_user and dispatch_agent. Extracted
 * from the Claude SDK construction in runtime.js — provider-neutral.
 *
 * ask_user: the reply round-trip (story 012) — the executor emits a
 * question event carrying the job id, then parks until
 * POST /api/agent/jobs/:id/reply delivers the answer (or the timeout / task
 * teardown unblocks it without one). Parking is unblocked by the questions
 * registry on teardown, so the executor does not need the turn's abort
 * signal.
 *
 * dispatch_agent: sub-agent dispatch — a Kuhn product operation, not a
 * provider capability. The dispatcher callback is injected by runTask
 * (which owns runAgentTask) so this module never imports the runtime
 * boundary (no import cycle, testable with a fake).
 *
 * The sub-agent inherits the dispatching user's attribution (story
 * 007-001), the seeding bypass (story 008-001): a sub-agent dispatched by a
 * seeding stage writes the first draft directly too — and the user's open
 * document (STH-43), so a "full pass on the doc" relayed by the PM lands on
 * the document the PI is actually looking at.
 */

import { config } from '../../config.js';
import { waitForReply } from '../questions.js';
import { remember } from '../../db/memory.js';
import { log } from '../../logger.js';
import { toolOk, toolError } from './envelope.js';

/**
 * The slice of a task's context a sub-agent should inherit (STH-43): where
 * the user is working. Selection/cursor stay with the agent that received
 * them — the dispatcher quotes what matters in the task text.
 * @param {object|null} context
 * @returns {object|undefined}
 */
export function inheritedContext(context) {
  if (!context) return undefined;
  const out = {};
  if (context.activeDocument) out.activeDocument = context.activeDocument;
  if (context.dir) out.dir = context.dir;
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {import('./registry.js').ToolContext} ctx
 */
export function createInteractionTools(ctx) {
  const {
    projectId, depth, budget, userId, seeding, context: taskContext,
  } = ctx;
  const { slug: agentSlug } = ctx.agent;
  const { id: jobId } = ctx.parentJob;

  const tools = [];
  // Deterministic memory writes (issue #150, spec §5): best effort — a
  // memory failure never fails the tool that triggered it.
  let questionSeq = 0;
  const writeMemory = (where, entry) => {
    try {
      return remember(projectId, entry);
    } catch (err) {
      log.warn('memory_write_failed', { jobId, agent: agentSlug, where, err });
      return null;
    }
  };

  tools.push({
    name: 'ask_user',
    grants: ['ask_user'],
    readOnly: true,
    effect: 'control',
    description:
      'Ask the user a question and wait for their reply. Use this for interview questions and any decision that needs user input. '
      + 'Ask one question at a time and adapt to earlier answers.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question to show the user' } },
      required: ['question'],
    },
    execute: async (_id, { question }) => {
      ctx.channel.push({ type: 'question', agent: agentSlug, jobId, content: question });
      const reply = await waitForReply(jobId, config.agent.questionTimeoutMs, { question, agent: agentSlug });
      // Control point 4 (issue #118 §5): a cancel, suspension or deadline
      // that landed while the run was parked is honoured as it wakes.
      const stopped = reply != null && ctx.gate ? await ctx.gate('wake', 'ask_user') : null;
      if (stopped) return toolError(`Run stopped (${stopped}) while waiting for the reply.`);
      if (reply == null) {
        // Tell the webapp the question is no longer answerable (story 020);
        // on task teardown the channel is already closed and this is a no-op.
        ctx.channel.push({ type: 'question_expired', agent: agentSlug, jobId });
        return toolOk(
          '[No reply received. Do not wait further: continue with sensible defaults and clearly note any assumptions you make.]',
        );
      }
      // Write 4: the user's answer is a decision the next run of ANY agent
      // can find — today it would vanish into this agent's session. Human
      // authored (no source agent), so no agent can overwrite it.
      questionSeq += 1;
      writeMemory('question', {
        kind: 'decision', key: `question:${jobId}:${questionSeq}`,
        body: `Q (${agentSlug}): ${question}\nA (user): ${reply}`,
        tags: [agentSlug, 'question'], sourceAgent: null, userId, jobId, truncate: true,
      });
      return toolOk(reply);
    },
  });

  tools.push({
    name: 'dispatch_agent',
    grants: ['spawn_agent'],
    // Withheld at the configured maximum depth (story 011): a sub-agent at
    // the limit cannot spawn further sub-agents.
    visible: (c) => c.depth < config.agent.maxDispatchDepth,
    readOnly: false,
    effect: 'control',
    description:
      "Dispatch a sub-agent to perform a focused task (e.g. ra for literature research, advisor for domain review). Returns the sub-agent's final output.",
    parameters: {
      type: 'object',
      properties: {
        agent_slug: { type: 'string', description: 'Agent to dispatch: pm, writer, ra, advisor, reviewer, analyst' },
        task: { type: 'string', description: 'Task description for the sub-agent' },
        context: { type: 'string', description: 'Additional context for the sub-agent' },
        difficulty: {
          type: 'number', minimum: 0, maximum: 1,
          description: 'How demanding the sub-task is, 0 to 1: 0 for a routine lookup or reformatting, 0.5 for ordinary drafting or review, 1 for work that needs the strongest model (deep reasoning, delicate judgement). The organization routes each agent to a cheaper or stronger model by this value; omit when unsure (treated as 1).',
        },
      },
      required: ['agent_slug', 'task'],
    },
    execute: async (_id, { agent_slug, task, context, difficulty }) => {
      const input = context ? `${task}\n\nContext: ${context}` : task;
      let finalText = '';
      let errorMessage = null;
      let childJobId = null;
      let finished = false;
      const child = ctx.dispatch(
        {
          role: agent_slug, projectId, input, userId, seeding, context: inheritedContext(taskContext), difficulty,
          // The sub-agent lives and dies with its parent (issue #136): when
          // the parent run is stopped — by the user, a disconnect, or the
          // budget — this signal ends the child's consumer, and the child's
          // own teardown interrupts its provider turn and marks it cancelled.
          signal: ctx.signal ?? undefined,
        },
        { depth: depth + 1, parentJobId: jobId, budget },
      );
      for await (const event of child) {
        if (event.jobId != null && childJobId == null && event.agent === agent_slug) childJobId = event.jobId;
        if (event.type === 'text') finalText += (finalText ? '\n' : '') + event.content;
        if (event.type === 'error') errorMessage = event.message;
        if (event.type === 'done') finished = true;
        // Forward child progress to the client; the parent emits the single
        // terminal 'done' for the whole task.
        if (event.type !== 'done') ctx.channel.push(event);
      }
      // Child lifecycle marker (issue #137): the client's activity/model
      // indicators follow the innermost running job, so they need to know
      // when a dispatched job ends — its 'done' is deliberately not forwarded
      // (it would read as the whole task finishing), and a stopped child
      // emits no terminal of its own.
      const stopped = !finished && errorMessage == null && ctx.signal?.aborted === true;
      ctx.channel.push({
        type: 'job', agent: agent_slug, jobId: childJobId, depth: depth + 1, parentJobId: jobId,
        status: errorMessage != null ? 'error' : stopped ? 'cancelled' : 'done',
      });
      if (errorMessage) {
        return toolError(`Sub-agent failed: ${errorMessage}`);
      }
      if (stopped) {
        return toolError('Sub-agent was stopped before it finished');
      }
      // Write 1: the child's final reply becomes a task_state entry keyed by
      // its job, so the next run of any agent starts knowing what this one
      // did — the record the #150 incident lacked. The dispatcher can point
      // at it instead of pasting it.
      const recorded = finalText
        ? writeMemory('dispatch', {
            kind: 'task_state', key: childJobId != null ? `task:${childJobId}` : null, body: finalText,
            tags: [agent_slug, 'dispatch'], sourceAgent: agent_slug, userId, jobId: childJobId ?? jobId,
            auto: true, truncate: true,
          })
        : null;
      const suffix = recorded ? `\n\n[Recorded as memory #${recorded.entry.id}.]` : '';
      return toolOk(finalText ? `${finalText}${suffix}` : '(sub-agent produced no output)');
    },
  });

  return tools;
}
