import { query } from '../db.js';

/** Parse a message row's JSON tool_calls column (TEXT in SQLite) to an array. */
function parseMessage(row) {
  if (row && typeof row.tool_calls === 'string') {
    row.tool_calls = JSON.parse(row.tool_calls);
  }
  return row;
}

/**
 * Create a new conversation container.
 * @param {string} agentSlug - Which agent this conversation is with
 * @param {number|null} projectId - Optional project FK
 * @param {number|null} userId - Who started it (story 007-001)
 * @returns {Promise<{id: number, agent_slug: string, project_id: number|null, user_id: number|null, created_at: Date}>}
 */
export async function createConversation(agentSlug, projectId = null, userId = null) {
  const { rows } = await query(
    `INSERT INTO conversations (agent_slug, project_id, user_id)
     VALUES ($1, $2, $3)
     RETURNING id, agent_slug, project_id, user_id, created_at`,
    [agentSlug, projectId, userId],
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
 * @param {number|null} msg.userId - Attribution (story 007-001): assistant/tool
 *   rows carry the user whose request ran the job
 * @param {boolean|null} msg.isError - Tool-result outcome (issue #42): true if
 *   the tool returned an error; null for non-tool rows
 * @returns {Promise<object>} The inserted message row
 */
export async function logMessage({ conversationId, role, content = null, toolCalls = null, toolCallId = null, tokenCount = null, userId = null, isError = null }) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, token_count, user_id, is_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      conversationId,
      role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolCallId,
      tokenCount,
      userId,
      isError == null ? null : (isError ? 1 : 0),
    ],
  );
  return parseMessage(rows[0]);
}

/**
 * Recent top-level conversations for a project with their user/assistant
 * messages, for chat transcript restore (story 020). Sub-agent conversations
 * (jobs with a parent) and seeding-pipeline stage conversations (story 015,
 * context.seedStage) are excluded — their dispatch/stage instructions would
 * replay as fake user messages. Conversations come back newest first;
 * messages within each are chronological.
 * Rows carry `user_id` (story 007-001) so the UI can label turns later;
 * pre-attribution history has NULL.
 * @param {number} projectId
 * @param {object} [opts]
 * @param {number} [opts.limit=20] - Max conversations
 * @returns {Promise<object[]>} [{ id, agent_slug, user_id, created_at, messages: [{ role, content, user_id, created_at }] }]
 */
export async function listProjectConversations(projectId, { limit = 20 } = {}) {
  const { rows: conversations } = await query(
    `SELECT c.id, c.agent_slug, c.user_id, c.created_at
     FROM conversations c
     JOIN jobs j ON j.conversation_id = c.id
     WHERE c.project_id = $1
       AND j.parent_job_id IS NULL
       AND (j.context IS NULL OR json_extract(j.context, '$.seedStage') IS NULL)
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $2`,
    [projectId, limit],
  );
  if (conversations.length === 0) return [];

  const ids = conversations.map((c) => c.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: messages } = await query(
    `SELECT conversation_id, role, content, user_id, created_at
     FROM messages
     WHERE conversation_id IN (${placeholders})
       AND role IN ('user', 'assistant')
       AND content IS NOT NULL AND content <> ''
     ORDER BY created_at ASC, id ASC`,
    ids,
  );

  const byConversation = new Map(conversations.map((c) => [c.id, { ...c, messages: [] }]));
  for (const { conversation_id, ...message } of messages) {
    byConversation.get(conversation_id)?.messages.push(message);
  }
  return [...byConversation.values()];
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
       AND ($2 IS NULL OR created_at < $2)
     ORDER BY created_at ASC
     LIMIT $3`,
    [conversationId, before instanceof Date ? before.toISOString() : before, limit],
  );
  return rows.map(parseMessage);
}
