/**
 * Chat activity (issue #113 item 3): the org-level lifecycle feed the
 * webapp's status marks render from — a ring on a project or agent while
 * one of the user's chats there is running, a dot while one is waiting on
 * them. Two halves:
 *
 *   - publishChatActivity — a compact { type: 'chat', … } record on the org
 *     hub (project-events.js) at every chat status transition: the runtime
 *     announces running / paused / idle at the job's start and terminals,
 *     and ask_user announces waiting_for_user / running as it parks and
 *     wakes. Fed from the same code paths that write the job row, so the
 *     feed and the DB projection (db/chats.js chatStatus) never disagree.
 *   - chatActivitySnapshot — what a feed subscriber is told on connect, from
 *     the DB projection plus the in-memory question text of the user's own
 *     parked runs, so a reload (or a backend restart, after which nothing
 *     is running) shows the right marks at once.
 *
 * Records name the chat's user so the route can decide who sees what: a
 * member sees their own chats (with the question text); an owner also sees
 * every other member's chats as status and agent only, never content.
 */

import { listChatActivity } from '../db/chats.js';
import { publishOrgEvent } from '../project-events.js';
import { getPendingQuestion } from './questions.js';

/**
 * @typedef {object} ChatActivity
 * @property {'chat'} type
 * @property {number} chatId
 * @property {number} projectId
 * @property {number|null} userId     - whose chat
 * @property {string} agent            - the chat's agent slug
 * @property {'idle'|'running'|'waiting_for_user'|'paused'} status
 * @property {number|null} jobId       - the chat's current (root) job
 * @property {string|null} [question]  - the pending question, own chats only
 */

/**
 * Announce a chat's status to the org hub.
 * @param {number} orgId
 * @param {Omit<ChatActivity, 'type'>} record
 */
export function publishChatActivity(orgId, record) {
  if (orgId == null || record?.chatId == null) return;
  publishOrgEvent(orgId, { type: 'chat', ...record, question: record.question ?? null });
}

/**
 * The non-idle chats a subscriber may see right now.
 * @param {number} orgId
 * @param {{ userId: number, everyone?: boolean }} who - `everyone` for owners
 * @returns {Promise<ChatActivity[]>}
 */
export async function chatActivitySnapshot(orgId, { userId, everyone = false }) {
  const rows = await listChatActivity(orgId, { userId, everyone });
  return rows.map((r) => {
    const mine = r.userId === userId;
    const q = mine && r.status === 'waiting_for_user' ? getPendingQuestion(r.waitingJobId ?? r.jobId) : null;
    return {
      type: 'chat', chatId: r.chatId, projectId: r.projectId, userId: r.userId, agent: r.agent,
      status: r.status, jobId: r.jobId, question: q?.question ?? null,
    };
  });
}

/**
 * What one subscriber may be told of a live record: their own chats whole;
 * other members' chats — owners only — without the question text.
 * @param {ChatActivity} event
 * @param {{ userId: number, everyone: boolean }} who
 * @returns {ChatActivity|null} the record to send, or null to withhold it
 */
export function visibleActivity(event, { userId, everyone }) {
  if (event?.type !== 'chat') return null;
  if (event.userId === userId) return event;
  if (!everyone) return null;
  const { question: _question, ...rest } = event;
  return { ...rest, question: null };
}
