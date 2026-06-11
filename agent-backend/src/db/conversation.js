import { query } from '../db.js';

/**
 * Create a new conversation container.
 * @param {string} agentSlug - Which agent this conversation is with
 * @param {number|null} projectId - Optional project FK
 * @returns {Promise<{id: number, agent_slug: string, project_id: number|null, created_at: Date}>}
 */
export async function createConversation(agentSlug, projectId = null) {
  const { rows } = await query(
    `INSERT INTO conversations (agent_slug, project_id)
     VALUES ($1, $2)
     RETURNING id, agent_slug, project_id, created_at`,
    [agentSlug, projectId],
  );
  return rows[0];
}

/**
 * Log a message to a conversation.
 * @param {object} msg
 * @param {number} msg.conversationId
 * @param {string} msg.role - 'system' | 'user' | 'assistant' | 'tool'
 * @param {string|null} msg.content
 * @param {object[]|null} msg.toolCalls - Array of tool call objects (assistant messages)
 * @param {string|null} msg.toolCallId - Tool call ID (tool result messages)
 * @param {number|null} msg.tokenCount
 * @returns {Promise<object>} The inserted message row
 */
export async function logMessage({ conversationId, role, content = null, toolCalls = null, toolCallId = null, tokenCount = null }) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, token_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      conversationId,
      role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolCallId,
      tokenCount,
    ],
  );
  return rows[0];
}

/**
 * Retrieve message history for a conversation, ordered chronologically.
 * @param {number} conversationId
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {Date|string|null} [opts.before] - Only messages before this timestamp
 * @returns {Promise<object[]>}
 */
export async function getHistory(conversationId, { limit = 100, before = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM messages
     WHERE conversation_id = $1
       AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at ASC
     LIMIT $3`,
    [conversationId, before, limit],
  );
  return rows;
}
