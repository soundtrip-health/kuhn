// Story 008-001: HTTP surface of suggestion mode. Same handler/error
// conventions as routes/files.js — the scope rule, hunk math, and
// accept/reject orchestration live in src/pending-edits.js; these handlers
// only translate HTTP and validate body shapes.

import { Router } from 'express';

import {
  acceptEdit,
  isSuggestionPath,
  listEdits,
  proposeEdit,
  rejectEdit,
} from '../pending-edits.js';
import { publishProjectEvent } from '../project-events.js';
import { StorageError } from '../storage.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
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
      await fn(projectId, req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STATUS_BY_CODE[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        console.error('[pending-edits] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/** Parse and validate :id; null (and a 400) when it is not a number. */
function requireEditId(req, res) {
  const id = parseInt(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'edit id must be a number' });
    return null;
  }
  return id;
}

/** Validate an optional { index, hash } hunk selector; false (and a 400) when malformed. */
function validHunk(hunk, res) {
  if (hunk == null) return true;
  if (typeof hunk.index !== 'number' || !Number.isInteger(hunk.index) || hunk.index < 0
      || typeof hunk.hash !== 'string' || hunk.hash.length === 0) {
    res.status(400).json({ error: 'hunk must be { index: number, hash: string }' });
    return false;
  }
  return true;
}

/** GET /api/projects/:projectId/pending-edits[?path=] — refreshed pending edits */
router.get('/api/projects/:projectId/pending-edits', handle(async (projectId, req, res) => {
  const path = typeof req.query.path === 'string' && req.query.path.length > 0 ? req.query.path : null;
  const edits = await listEdits(projectId, { path });
  res.json({ edits });
}));

/**
 * POST /api/projects/:projectId/pending-edits — body { path, proposedContent,
 * agent?, jobId? }. Creates/coalesces a pending edit exactly as the agent
 * tool path does (token-free check scripts, future human proposals). 400 for
 * paths outside the suggestion scope.
 */
router.post('/api/projects/:projectId/pending-edits', handle(async (projectId, req, res) => {
  const { path, proposedContent, agent = null, jobId = null } = req.body ?? {};
  if (typeof path !== 'string' || path.length === 0 || typeof proposedContent !== 'string') {
    res.status(400).json({ error: 'path and proposedContent are required' });
    return;
  }
  if (!isSuggestionPath(path)) {
    res.status(400).json({ error: `Suggestions cover draft/** only: ${path}` });
    return;
  }
  const edit = await proposeEdit(projectId, { path, proposedContent, agentSlug: agent, jobId });
  // Same live signal the agent tool path emits via fileChangeEvent: tabs
  // re-fetch pending edits on any file_change; 'proposed' is SSE-only.
  publishProjectEvent(projectId, {
    type: 'file_change', agent: edit.agent, path: edit.path, kind: 'proposed',
  }, { jobId: edit.jobId, userId: req.user?.id ?? null });
  res.status(201).json(edit);
}));

/**
 * POST /api/projects/:projectId/pending-edits/:id/accept — body
 * { hunk?: {index, hash}, force? }. No hunk = accept all; force is only valid
 * without a hunk (whole-file replace of a stale row). 409 on stale-without-
 * force and on hunk races.
 */
router.post('/api/projects/:projectId/pending-edits/:id/accept', handle(async (projectId, req, res) => {
  const id = requireEditId(req, res);
  if (id == null) return;
  const { hunk = null, force = false } = req.body ?? {};
  if (!validHunk(hunk, res)) return;
  if (force && hunk != null) {
    res.status(400).json({ error: 'force applies to whole-file accepts only — omit hunk' });
    return;
  }
  const result = await acceptEdit(projectId, id, { hunk, force: force === true, userId: req.user?.id ?? null });
  res.json(result);
}));

/**
 * POST /api/projects/:projectId/pending-edits/:id/reject — body
 * { hunk?: {index, hash} }. No hunk = discard the whole edit. No file write,
 * no activity row, no commit.
 */
router.post('/api/projects/:projectId/pending-edits/:id/reject', handle(async (projectId, req, res) => {
  const id = requireEditId(req, res);
  if (id == null) return;
  const { hunk = null } = req.body ?? {};
  if (!validHunk(hunk, res)) return;
  const result = await rejectEdit(projectId, id, { hunk, userId: req.user?.id ?? null });
  res.json(result);
}));

export default router;
