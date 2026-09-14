// Chats (issue #113 item 1): the durable server-side thread between a user
// and one agent in one project. Before this the provider session id, the
// canonical continuation, the per-agent model pin and the fresh-start
// hand-off note lived in the browser tab and were wiped on a project switch;
// two tabs forked a conversation. Now the chat row is authoritative and the
// client merely names the chat (or the project + agent, which resolves to
// one). One row per (project, agent, user); created on first use.
//
// Status is NOT stored: `status` is a read-time projection of
// current_job_id's job row — see chatStatus(). #118 stage 1 widened the job
// states (queued | running | waiting_for_user | retry_wait are all open);
// a distinct 'waiting' chat status arrives with stage 2, when a parked
// ask_user becomes a persisted job state instead of in-memory runtime state.

import { query } from '../db.js';
import { isBudgetPaused } from '../agents/budget-pause.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// The row plus the columns of its current job the projection needs.
const SELECT = `
  SELECT c.*, j.status AS job_status, j.error AS job_error
  FROM chats c
  LEFT JOIN jobs j ON j.id = c.current_job_id`;

/**
 * Project a chat's status from its current job (see the module note):
 * 'running' while that job is open (queued, running, parked on a question
 * or in a retry wait), 'paused' when the token budget paused it (the
 * budget-pause convention: status 'error' with the BUDGET_EXCEEDED_ERROR
 * text), else 'idle'.
 * @param {{ status?: string, error?: string|null } | null | undefined} job
 * @returns {'idle'|'running'|'paused'}
 */
const OPEN = new Set(['queued', 'running', 'waiting_for_user', 'retry_wait']);
export function chatStatus(job) {
  if (!job) return 'idle';
  if (OPEN.has(job.status)) return 'running';
  if (isBudgetPaused(job)) return 'paused';
  return 'idle';
}

/** Parse the JSON column and fold the joined job columns into `status`. */
function parseChat(row) {
  if (!row) return undefined;
  const { job_status: jobStatus, job_error: jobError, ...chat } = row;
  if (typeof chat.continuation === 'string') chat.continuation = JSON.parse(chat.continuation);
  chat.status = chatStatus(jobStatus != null ? { status: jobStatus, error: jobError } : null);
  return chat;
}

/** @returns {Promise<object|undefined>} the chat with its projected status */
export async function getChat(chatId) {
  const { rows } = await query(`${SELECT} WHERE c.id = $1`, [chatId]);
  return parseChat(rows[0]);
}

/**
 * The user's chat with an agent in a project, created on first use.
 * Idempotent per (project, agent, user): a concurrent first message from two
 * tabs resolves to the same row (the UNIQUE constraint arbitrates).
 * @returns {Promise<object>} the chat with its projected status
 */
export async function getOrCreateChat({ projectId, agentSlug, userId }) {
  await query(
    `INSERT INTO chats (project_id, agent_slug, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, agent_slug, user_id) DO NOTHING`,
    [projectId, agentSlug, userId],
  );
  const { rows } = await query(
    `${SELECT} WHERE c.project_id = $1 AND c.agent_slug = $2 AND c.user_id = $3`,
    [projectId, agentSlug, userId],
  );
  return parseChat(rows[0]);
}

/**
 * A user's chats in a project, with projected statuses, most recently
 * active first. Only the caller's own chats: another member's threads are
 * not this user's conversations (spec §6 — content stays with its user).
 * @returns {Promise<object[]>}
 */
export async function listProjectChats(projectId, userId) {
  const { rows } = await query(
    `${SELECT} WHERE c.project_id = $1 AND c.user_id = $2
     ORDER BY c.last_message_at DESC NULLS LAST, c.id ASC`,
    [projectId, userId],
  );
  return rows.map(parseChat);
}

/**
 * Update mutable chat fields. Only provided keys are changed; an explicit
 * null clears a column.
 * @param {number} chatId
 * @param {object} fields
 * @param {string|null} [fields.title]
 * @param {string|null} [fields.sessionId]
 * @param {object|null} [fields.continuation]
 * @param {string|null} [fields.pinnedProfile]
 * @param {string|null} [fields.pendingHandoff]
 * @param {number|null} [fields.currentJobId]
 * @param {string|null} [fields.lastMessageAt]
 * @returns {Promise<object|undefined>} the updated chat
 */
export async function updateChat(chatId, fields) {
  const columns = {
    title: 'title',
    sessionId: 'session_id',
    continuation: 'continuation',
    pinnedProfile: 'pinned_profile',
    pendingHandoff: 'pending_handoff',
    currentJobId: 'current_job_id',
    lastMessageAt: 'last_message_at',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      params.push(column === 'continuation' && fields[key] != null ? JSON.stringify(fields[key]) : fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getChat(chatId);
  params.push(chatId);
  await query(
    `UPDATE chats SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = $${params.length}`,
    params,
  );
  return getChat(chatId);
}

/**
 * A top-level run started on this chat: it becomes the current job and the
 * thread's activity timestamp moves. The pending hand-off note is consumed
 * here — the task route spliced it into this run's input, so "delivered"
 * means "a job carrying it exists" (a run refused before a job is created
 * keeps the note for the next attempt).
 */
export async function startChatJob(chatId, jobId) {
  await query(
    `UPDATE chats SET current_job_id = $2, pending_handoff = NULL,
       last_message_at = ${NOW}, updated_at = ${NOW}
     WHERE id = $1`,
    [chatId, jobId],
  );
}

/**
 * Record what a run left behind on its chat: the provider session and the
 * canonical continuation a follow-up resumes from. Guarded on current_job_id
 * so a run's late terminal (a stop settling after a fresh start, say) cannot
 * re-seed a chat that has since been reset.
 * @param {{ sessionId?: string|null, continuation?: object|null }} state
 */
export async function recordChatRun(chatId, jobId, { sessionId = null, continuation = null } = {}) {
  await query(
    `UPDATE chats SET session_id = $3, continuation = $4,
       last_message_at = ${NOW}, updated_at = ${NOW}
     WHERE id = $1 AND current_job_id = $2`,
    [chatId, jobId, sessionId, continuation != null ? JSON.stringify(continuation) : null],
  );
}

/**
 * Fresh start (STH-55, now server-side): forget the provider session, the
 * continuation and the current job, and park the hand-off note (if any) for
 * the next message. The model pin survives — it is the user's choice for the
 * agent, not conversation context. The transcript is untouched.
 * @param {{ handoff?: string|null }} [opts]
 * @returns {Promise<object|undefined>} the reset chat
 */
export async function resetChat(chatId, { handoff = null } = {}) {
  return updateChat(chatId, { sessionId: null, continuation: null, currentJobId: null, pendingHandoff: handoff ?? null });
}

/** Discard a parked hand-off note ("Discard note" on the card). */
export async function clearPendingHandoff(chatId) {
  return updateChat(chatId, { pendingHandoff: null });
}

/** Pin (or unpin, with null) the model profile the agent in this chat runs on (issue #134). */
export async function setPinnedProfile(chatId, profile) {
  return updateChat(chatId, { pinnedProfile: profile ?? null });
}
