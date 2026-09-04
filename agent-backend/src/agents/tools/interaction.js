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
      if (reply == null) {
        // Tell the webapp the question is no longer answerable (story 020);
        // on task teardown the channel is already closed and this is a no-op.
        ctx.channel.push({ type: 'question_expired', agent: agentSlug, jobId });
        return toolOk(
          '[No reply received. Do not wait further: continue with sensible defaults and clearly note any assumptions you make.]',
        );
      }
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
      const child = ctx.dispatch(
        { role: agent_slug, projectId, input, userId, seeding, context: inheritedContext(taskContext), difficulty },
        { depth: depth + 1, parentJobId: jobId, budget },
      );
      for await (const event of child) {
        if (event.type === 'text') finalText += (finalText ? '\n' : '') + event.content;
        if (event.type === 'error') errorMessage = event.message;
        // Forward child progress to the client; the parent emits the single
        // terminal 'done' for the whole task.
        if (event.type !== 'done') ctx.channel.push(event);
      }
      if (errorMessage) {
        return toolError(`Sub-agent failed: ${errorMessage}`);
      }
      return toolOk(finalText || '(sub-agent produced no output)');
    },
  });

  return tools;
}
