// Chats HTTP surface (issue #113 item 1): the durable per-user thread with
// one agent in one project. Tenancy (story 010-003): the project-scoped
// routes carry :id in the path; the chat-scoped ones resolve the project
// from the stored chat row. Listing is a read (viewer); creating a chat,
// pinning a model and starting fresh are writes (editor). A chat belongs to
// the user who opened it — another member may not pin, reset or continue it,
// and the list shows only the caller's own.

import { Router } from 'express';
import { captureHandoff } from '../agents/handoff.js';
import { clearPendingHandoff, getChat, getOrCreateChat, listProjectChats, resetChat, setPinnedProfile } from '../db/chats.js';
import { requireProjectRole } from './guards.js';

const router = Router();

/**
 * Resolve the chat named by :id, require minRole in its project's org, and
 * require the caller to own it. Unknown chat → 404; the guard sends its own
 * refusals (non-leaking 404 for non-members, 403 for role/suspension).
 * @returns {Promise<object|null>} the chat row, or null after responding
 */
async function requireOwnChat(req, res, minRole) {
  const chat = await getChat(parseInt(req.params.id));
  if (!chat) {
    res.status(404).json({ error: 'chat not found' });
    return null;
  }
  if (!(await requireProjectRole(req, res, chat.project_id, minRole))) return null;
  if (chat.user_id !== req.user.id) {
    res.status(403).json({ error: 'not your chat' });
    return null;
  }
  return chat;
}

/**
 * GET /api/projects/:id/chats → { chats } — the caller's chats in the
 * project with their projected `status` ('idle' | 'running' | 'paused';
 * 'waiting_for_user' arrives with #118 stage 1). The webapp reads its
 * per-agent state (pin, parked hand-off note, chat id) from here on load.
 */
router.get('/api/projects/:id/chats', async (req, res) => {
  const project = await requireProjectRole(req, res, req.params.id, 'viewer');
  if (!project) return;
  res.json({ chats: await listProjectChats(project.id, req.user.id) });
});

/**
 * PUT /api/projects/:id/chats/:agent → { chat } — the caller's chat with
 * that agent, created on first use (idempotent). The model picker uses this
 * to have a row to pin on before the first message.
 */
router.put('/api/projects/:id/chats/:agent', async (req, res) => {
  const project = await requireProjectRole(req, res, req.params.id, 'editor');
  if (!project) return;
  const agent = String(req.params.agent);
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(agent)) {
    res.status(400).json({ error: 'invalid agent slug' });
    return;
  }
  res.json({ chat: await getOrCreateChat({ projectId: project.id, agentSlug: agent, userId: req.user.id }) });
});

/**
 * PATCH /api/chats/:id — body { pinned_profile?: string|null, pending_handoff?: null }
 * Pin (or unpin) the model the agent runs on in this chat (issue #134), and
 * discard a parked hand-off note ("Discard note"). A note can only be
 * cleared here, never written: notes come from the reset scan.
 */
router.patch('/api/chats/:id', async (req, res) => {
  const body = req.body ?? {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('pinned_profile') && !has('pending_handoff')) {
    res.status(400).json({ error: 'nothing to update: pinned_profile or pending_handoff required' });
    return;
  }
  if (has('pinned_profile') && body.pinned_profile !== null && (typeof body.pinned_profile !== 'string' || !body.pinned_profile)) {
    res.status(400).json({ error: 'pinned_profile must be a profile slug or null' });
    return;
  }
  if (has('pending_handoff') && body.pending_handoff !== null) {
    res.status(400).json({ error: 'pending_handoff can only be cleared (null)' });
    return;
  }
  const chat = await requireOwnChat(req, res, 'editor');
  if (!chat) return;
  let updated = chat;
  if (has('pinned_profile')) updated = await setPinnedProfile(chat.id, body.pinned_profile);
  if (has('pending_handoff')) updated = await clearPendingHandoff(chat.id);
  res.json({ chat: updated });
});

/**
 * POST /api/chats/:id/reset → { chat, handoff } — fresh start (STH-55,
 * server-side since #113). Scans the recorded conversation tail for a clear
 * hand-off, then forgets the provider session / continuation / current job
 * and parks the note for the next message. 409 while the chat's run is
 * still going: clearing under a live run would orphan it. A failed scan
 * still resets the chat (the pre-STH-55 behaviour) and reports
 * `handoff_error` so the client can say so.
 */
router.post('/api/chats/:id/reset', async (req, res) => {
  const chat = await requireOwnChat(req, res, 'editor');
  if (!chat) return;
  if (chat.status === 'running') {
    res.status(409).json({ error: 'chat has a run in progress' });
    return;
  }
  let handoff = null;
  let handoffError = null;
  if (req.body?.handoff !== false) {
    try {
      ({ handoff } = await captureHandoff(chat.project_id, chat.agent_slug));
    } catch (err) {
      console.error('[chats] hand-off scan failed:', err);
      handoffError = err.message;
    }
  }
  const reset = await resetChat(chat.id, { handoff });
  res.json({ chat: reset, handoff: handoff ?? null, ...(handoffError ? { handoff_error: handoffError } : {}) });
});

export default router;
