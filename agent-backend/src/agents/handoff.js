// STH-55: "start fresh" hand-off capture. When the user clears an agent's
// chat context, scan the tail of the recorded conversation for a clear
// hand-off — an open question from the agent, an agreed-but-unstarted next
// step, hard-won implementation guidance — and distill it into a short note
// the fresh session receives with the user's next message. One small
// Messages API call over the transcript tail; the issue's heuristic (weigh
// the last message; read back further when it is ambiguous) is delegated to
// the model, which sees the last few messages at once.

import Anthropic from '@anthropic-ai/sdk';

import { config } from '../config.js';
import { getRecentAgentMessages } from '../db/conversation.js';

let defaultClient = null;
function client() {
  defaultClient ??= new Anthropic(); // ANTHROPIC_API_KEY from the environment
  return defaultClient;
}

const SYSTEM = `You scan the tail of a chat between a user and one of their scientific-writing agents, just before the user resets that agent's context. Decide whether the conversation ends in a clear hand-off: an open question from the agent, an agreed-but-unstarted next step, or hard-won guidance the fresh session would otherwise lose. Weigh the last message most; use the earlier ones for context when the last is ambiguous.

If there is NO clear hand-off — the work concluded, or nothing actionable is pending — reply with exactly:
NONE

Otherwise reply with ONLY a hand-off note (no preamble), under 150 words, addressed to the agent's fresh session:
- open action items / the pending decision, most important first
- decisions already made and key implementation guidance worth preserving
Do not invent tasks that were not discussed.`;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}\n[…truncated]` : s);

/**
 * Scan an agent's recent conversation tail. Returns { handoff } — a short
 * note when the tail contains a clear hand-off, else null.
 * @param {object} [deps] - { anthropic } injectable for tests
 */
export async function captureHandoff(projectId, agentSlug, { anthropic = null } = {}) {
  const { model, maxMessages, maxCharsPerMessage } = config.handoff;
  const messages = await getRecentAgentMessages(projectId, agentSlug, { limit: maxMessages });
  if (messages.length === 0) return { handoff: null };

  const transcript = messages
    .map((m) => `[${m.role === 'user' ? 'USER' : 'AGENT'}]\n${clip(m.content, maxCharsPerMessage)}`)
    .join('\n\n');

  const response = await (anthropic ?? client()).messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Conversation tail (oldest first — the LAST message is the most recent):\n\n${transcript}`,
    }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text || text === 'NONE') return { handoff: null };
  return { handoff: text };
}
