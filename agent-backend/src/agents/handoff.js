// Hand-off notes: short model-written summaries of where a conversation
// stands, handed to the run that picks the work up.
//
// STH-55: "start fresh" hand-off capture. When the user clears an agent's
// chat context, scan the tail of the recorded conversation for a clear
// hand-off — an open question from the agent, an agreed-but-unstarted next
// step, hard-won implementation guidance — and distill it into a short note
// the fresh session receives with the user's next message. One small
// Messages API call over the transcript tail; the issue's heuristic (weigh
// the last message; read back further when it is ambiguous) is delegated to
// the model, which sees the last few messages at once.
//
// Issue #110: budget-pause hand-off. When the token budget interrupts a run
// mid-task, the runtime asks the same machinery for a note on what was in
// progress, what remains, and which decisions were taken — the interrupted
// agent cannot write one itself (its turn was aborted), so the note is
// distilled from Kuhn's record of the conversation. It is stored on the job
// and delivered when the user resumes.

import Anthropic from '@anthropic-ai/sdk';

import { config } from '../config.js';
import { getRecentAgentMessages } from '../db/conversation.js';

let defaultClient = null;
function client() {
  defaultClient ??= new Anthropic(); // ANTHROPIC_API_KEY from the environment
  return defaultClient;
}

const FRESH_START_SYSTEM = `You scan the tail of a chat between a user and one of their scientific-writing agents, just before the user resets that agent's context. Decide whether the conversation ends in a clear hand-off: an open question from the agent, an agreed-but-unstarted next step, or hard-won guidance the fresh session would otherwise lose. Weigh the last message most; use the earlier ones for context when the last is ambiguous.

If there is NO clear hand-off — the work concluded, or nothing actionable is pending — reply with exactly:
NONE

Otherwise reply with ONLY a hand-off note (no preamble), under 150 words, addressed to the agent's fresh session:
- open action items / the pending decision, most important first
- decisions already made and key implementation guidance worth preserving
Do not invent tasks that were not discussed.`;

const BUDGET_PAUSE_SYSTEM = `You read the tail of a chat between a user and one of their scientific-writing agents. The agent's run was just interrupted mid-task because it reached its token budget; the user will resume it later, possibly in a fresh session that has none of this context.

Reply with ONLY a hand-off note (no preamble), under 150 words, addressed to the agent that resumes:
- what was in progress when the run stopped (be specific: which file, section, or step)
- what is already done and should not be redone
- the next steps, most important first
- decisions the user and agent took that the resumed run must honour
Do not invent tasks that were not discussed. If the tail shows no task in progress, say so in one sentence.`;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n[…truncated]` : s);

/**
 * One Messages API call over an agent's recent conversation tail.
 * @returns {Promise<string|null>} the model's trimmed reply, or null when
 *   there is no tail to summarize
 */
async function summarizeTail(projectId, agentSlug, system, { anthropic = null } = {}) {
  const { model, maxMessages, maxCharsPerMessage } = config.handoff;
  const messages = await getRecentAgentMessages(projectId, agentSlug, { limit: maxMessages });
  if (messages.length === 0) return null;

  const transcript = messages
    .map((m) => `[${m.role === 'user' ? 'USER' : 'AGENT'}]\n${clip(m.content, maxCharsPerMessage)}`)
    .join('\n\n');

  const response = await (anthropic ?? client()).messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{
      role: 'user',
      content: `Conversation tail (oldest first — the LAST message is the most recent):\n\n${transcript}`,
    }],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Scan an agent's recent conversation tail (STH-55). Returns { handoff } — a
 * short note when the tail contains a clear hand-off, else null.
 * @param {object} [deps] - { anthropic } injectable for tests
 */
export async function captureHandoff(projectId, agentSlug, deps = {}) {
  const text = await summarizeTail(projectId, agentSlug, FRESH_START_SYSTEM, deps);
  if (!text || text === 'NONE') return { handoff: null };
  return { handoff: text };
}

/**
 * Distill a hand-off note for a run the token budget just interrupted (issue
 * #110). Unlike captureHandoff there is no "NONE" outcome: a paused task
 * always has a state worth recording. Returns { handoff } — null only when
 * the agent has no recorded conversation to summarize.
 * @param {object} [deps] - { anthropic } injectable for tests
 */
export async function captureBudgetHandoff(projectId, agentSlug, deps = {}) {
  const text = await summarizeTail(projectId, agentSlug, BUDGET_PAUSE_SYSTEM, deps);
  // Models like to title the note anyway; the card supplies its own label.
  const body = (text ?? '').replace(/^(?:#+\s*|\*\*)?hand-off note:?(?:\*\*)?\s*\n+/i, '').trim();
  return { handoff: body || null };
}
