// Story 008-002: HTTP surface of the version history. Same handler/error
// conventions as routes/files.js — path safety and git mechanics live in
// src/history.js / src/storage.js; these handlers translate HTTP.

import { Router } from 'express';
import { extname } from 'node:path';

import { commitNow, fileAtVersion, listHistory } from '../history.js';
import { publishProjectEvent } from '../project-events.js';
import { StorageError, writeProjectFile } from '../storage.js';

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
        console.error('[history] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/** GET /api/projects/:projectId/history?path=&limit= — versions, newest first */
router.get('/api/projects/:projectId/history', handle(async (projectId, req, res) => {
  const path = typeof req.query.path === 'string' && req.query.path.length > 0 ? req.query.path : null;
  const limit = parseInt(req.query.limit) || 50;
  const history = await listHistory(projectId, path, limit);
  res.json({ history });
}));

/** GET /api/projects/:projectId/history/file?path=&ref= — content at a version */
router.get('/api/projects/:projectId/history/file', handle(async (projectId, req, res) => {
  const { path, ref } = req.query;
  if (typeof path !== 'string' || path.length === 0 || typeof ref !== 'string') {
    res.status(400).json({ error: 'path and ref query parameters are required' });
    return;
  }
  const buf = await fileAtVersion(projectId, path, ref);
  const TEXT_TYPES = { '.md': 'text/markdown; charset=utf-8' };
  res.set('Content-Type', TEXT_TYPES[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8');
  res.send(buf);
}));

/**
 * POST /api/projects/:projectId/history/restore — body { path, ref }.
 * Append-only: snapshots the current state, writes the old content back
 * through the normal storage path, and commits that as a new version.
 */
router.post('/api/projects/:projectId/history/restore', handle(async (projectId, req, res) => {
  const { path, ref } = req.body ?? {};
  if (typeof path !== 'string' || path.length === 0 || typeof ref !== 'string') {
    res.status(400).json({ error: 'path and ref are required' });
    return;
  }
  const buf = await fileAtVersion(projectId, path, ref); // validates ref + path first
  await commitNow(projectId, { userId: req.user?.id ?? null, label: `Snapshot before restoring ${path}` });
  const { created } = await writeProjectFile(projectId, path, buf);
  publishProjectEvent(projectId, {
    type: 'file_change', path, kind: created ? 'create' : 'update',
  }, { userId: req.user?.id ?? null });
  const hash = await commitNow(projectId, {
    userId: req.user?.id ?? null,
    label: `Restore ${path} to ${ref.slice(0, 8)}`,
  });
  res.json({ path, ref, restored: true, commit: hash });
}));

export default router;
