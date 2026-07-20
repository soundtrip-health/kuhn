// Story 008-004: HTTP surface of margin comments. Same handler/error
// conventions as routes/pending-edits.js, plus a project-membership guard
// (the authorizeProject pattern from routes/projects.js): comments are
// user-authored prose, so unlike the file routes these do not trust
// :projectId alone. 404 on non-membership — don't leak existence.

import { Router } from 'express';

import {
  addReply,
  createThread,
  deleteOwn,
  listThreads,
  setResolved,
  unresolvedCounts,
  updateAnchor,
} from '../db/comments.js';
import { getProject } from '../db/projects.js';
import { isMember } from '../db/orgs.js';
import { publishProjectEvent } from '../project-events.js';
import { StorageError } from '../storage.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
  forbidden: 403,
  invalid_path: 400,
  too_large: 413,
  conflict: 409,
};

function handle(fn) {
  return async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    if (Number.isNaN(projectId)) {
      res.status(400).json({ error: 'projectId must be a number' });
      return;
    }
    try {
      const project = await getProject(projectId);
      if (!project || req.user == null || !(await isMember(req.user.id, project.org_id))) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      await fn(projectId, req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STATUS_BY_CODE[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        console.error('[comments] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/** Parse and validate :id; null (and a 400) when it is not a number. */
function requireCommentId(req, res) {
  const id = parseInt(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'comment id must be a number' });
    return null;
  }
  return id;
}

function commentEvent(projectId, { action, path, id, rootId, agent = null }, userId) {
  publishProjectEvent(projectId, { type: 'comment', action, path, id, rootId, agent }, { userId });
}

/** GET /api/projects/:projectId/comments[?path=] — threads with nested replies */
router.get('/api/projects/:projectId/comments', handle(async (projectId, req, res) => {
  const path = typeof req.query.path === 'string' && req.query.path.length > 0 ? req.query.path : null;
  res.json({ threads: listThreads(projectId, { path }) });
}));

/** GET /api/projects/:projectId/comments/counts — unresolved threads per path */
router.get('/api/projects/:projectId/comments/counts', handle(async (projectId, req, res) => {
  res.json({ counts: unresolvedCounts(projectId) });
}));

/**
 * POST /api/projects/:projectId/comments — body { path, body,
 * anchor?: { quote, start?, end? } }. Creates a thread root authored by the
 * session user. The anchor is the editor's selection, stored as given — the
 * server does not second-guess a human selection (the agent path resolves
 * its quote in the add_comment tool before it gets here).
 */
router.post('/api/projects/:projectId/comments', handle(async (projectId, req, res) => {
  const { path, body, anchor = null } = req.body ?? {};
  if (typeof path !== 'string' || path.length === 0 || typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'path and a non-empty body are required' });
    return;
  }
  if (anchor != null && typeof anchor.quote !== 'string') {
    res.status(400).json({ error: 'anchor.quote must be a string when an anchor is given' });
    return;
  }
  const thread = createThread(projectId, {
    path,
    body: body.trim(),
    quote: anchor?.quote ?? null,
    start: Number.isInteger(anchor?.start) ? anchor.start : null,
    end: Number.isInteger(anchor?.end) ? anchor.end : null,
    userId: req.user?.id ?? null,
  });
  commentEvent(projectId, { action: 'create', path, id: thread.id, rootId: thread.id }, req.user?.id ?? null);
  res.status(201).json(thread);
}));

/** POST /api/projects/:projectId/comments/:id/replies — body { body } */
router.post('/api/projects/:projectId/comments/:id/replies', handle(async (projectId, req, res) => {
  const id = requireCommentId(req, res);
  if (id == null) return;
  const { body } = req.body ?? {};
  if (typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'a non-empty body is required' });
    return;
  }
  const reply = addReply(projectId, id, { body: body.trim(), userId: req.user?.id ?? null });
  commentEvent(projectId, { action: 'reply', path: reply.path, id: reply.id, rootId: id }, req.user?.id ?? null);
  res.status(201).json(reply);
}));

/** POST /api/projects/:projectId/comments/:id/resolve — resolve the thread */
router.post('/api/projects/:projectId/comments/:id/resolve', handle(async (projectId, req, res) => {
  const id = requireCommentId(req, res);
  if (id == null) return;
  const thread = setResolved(projectId, id, true, { userId: req.user?.id ?? null });
  commentEvent(projectId, { action: 'resolve', path: thread.path, id, rootId: id }, req.user?.id ?? null);
  res.json(thread);
}));

/** POST /api/projects/:projectId/comments/:id/reopen — reopen the thread */
router.post('/api/projects/:projectId/comments/:id/reopen', handle(async (projectId, req, res) => {
  const id = requireCommentId(req, res);
  if (id == null) return;
  const thread = setResolved(projectId, id, false, { userId: req.user?.id ?? null });
  commentEvent(projectId, { action: 'reopen', path: thread.path, id, rootId: id }, req.user?.id ?? null);
  res.json(thread);
}));

/**
 * PATCH /api/projects/:projectId/comments/:id/anchor — body
 * { quote?, start?, end?, orphaned? }. Anchor maintenance from a live editor:
 * the open tab writes back drifted quotes/offsets and flags (or clears)
 * orphaning. No feed event — anchors are presentation state, and echoing
 * every keystroke-driven drift back to all tabs would be noise.
 */
router.patch('/api/projects/:projectId/comments/:id/anchor', handle(async (projectId, req, res) => {
  const id = requireCommentId(req, res);
  if (id == null) return;
  const { quote, start, end, orphaned } = req.body ?? {};
  if (quote != null && typeof quote !== 'string') {
    res.status(400).json({ error: 'quote must be a string' });
    return;
  }
  if ((start != null && !Number.isInteger(start)) || (end != null && !Number.isInteger(end))) {
    res.status(400).json({ error: 'start and end must be integers' });
    return;
  }
  res.json(updateAnchor(projectId, id, { quote, start, end, orphaned: orphaned == null ? null : orphaned === true }));
}));

/** DELETE /api/projects/:projectId/comments/:id — author-only */
router.delete('/api/projects/:projectId/comments/:id', handle(async (projectId, req, res) => {
  const id = requireCommentId(req, res);
  if (id == null) return;
  const { path, rootId } = deleteOwn(projectId, id, { userId: req.user?.id ?? null });
  commentEvent(projectId, { action: 'delete', path, id, rootId }, req.user?.id ?? null);
  res.json({ ok: true });
}));

export default router;
