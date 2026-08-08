// Story 018: HTTP surface of the storage service — project tree, file CRUD,
// move, and multipart upload. Consumed by the webapp (stories 013/014).
// All path safety lives in src/storage.js; these handlers only translate
// HTTP <-> storage calls and map StorageError codes to status codes.
// Tenancy (story 010-003): every route passes requireProjectRole — reads need
// viewer, mutations need editor; non-members get a non-leaking 404.

import { Router } from 'express';
import express from 'express';
import { extname } from 'node:path';

import { config } from '../config.js';
import { unseenPaths } from '../db/file-activity.js';
import { findPendingEditConflicts } from '../db/move-paths.js';
import { commitNow, scheduleCommit } from '../history.js';
import { publishProjectEvent } from '../project-events.js';
import { bodyErrorHandler, uploadMiddleware } from './uploads.js';
import { requireProjectRole } from './guards.js';
import {
  StorageError,
  createProjectDir,
  readProjectFile,
  writeProjectFile,
  deleteProjectEntry,
  moveProjectEntry,
  listProjectTree,
} from '../storage.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
  invalid_path: 400,
  too_large: 413,
  conflict: 409,
};

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.typ': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function handle(minRole, fn) {
  return async (req, res) => {
    try {
      const project = await requireProjectRole(req, res, req.params.projectId, minRole);
      if (!project) return;
      await fn(project.id, req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STATUS_BY_CODE[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        console.error('[files] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

function requirePath(req, res) {
  const path = req.query.path;
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path query parameter is required' });
    return null;
  }
  return path;
}

/** Flag tree files whose latest event the current user has not seen (005-002). */
function annotateUnseen(nodes, unseen) {
  for (const node of nodes) {
    if (node.type === 'dir') annotateUnseen(node.children ?? [], unseen);
    else if (unseen.has(node.path)) node.unseen = true;
  }
}

/** GET /api/projects/:projectId/files[?path=subdir] — project tree */
router.get('/api/projects/:projectId/files', handle('viewer', async (projectId, req, res) => {
  const tree = await listProjectTree(projectId, typeof req.query.path === 'string' ? req.query.path : '.');
  const unseen = unseenPaths(projectId, req.user?.id ?? null);
  if (unseen.size > 0) annotateUnseen(tree, unseen);
  res.json({ tree });
}));

/** GET /api/projects/:projectId/file?path=... — raw file content */
router.get('/api/projects/:projectId/file', handle('viewer', async (projectId, req, res) => {
  const path = requirePath(req, res);
  if (path == null) return;
  const buf = await readProjectFile(projectId, path);
  res.set('Content-Type', CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
  res.send(buf);
}));

/**
 * PUT /api/projects/:projectId/file?path=... — create/overwrite a file.
 * Body is the raw file content (text/plain or application/octet-stream).
 * Deliberately NOT published to the project feed / activity log (005-002):
 * this is the editor's debounced autosave path, which would flood the log and
 * mark the open document perpetually unseen; live doc sync is Yjs's job.
 */
// Same request-time-limit rationale as uploadMiddleware below.
const rawBody = (req, res, next) =>
  express.raw({ type: () => true, limit: config.storage.maxFileBytes })(req, res, next);

router.put(
  '/api/projects/:projectId/file',
  rawBody,
  handle('editor', async (projectId, req, res) => {
    const path = requirePath(req, res);
    if (path == null) return;
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: 'Send the raw file content as the request body' });
      return;
    }
    const { created } = await writeProjectFile(projectId, path, req.body);
    // Version history (008-002): autosaves coalesce into the throttled
    // auto-commit; an explicit Cmd/Ctrl+S (?checkpoint=1) commits now.
    if (req.query.checkpoint === '1') {
      void commitNow(projectId, { userId: req.user?.id ?? null, label: `Save ${path}` });
    } else {
      scheduleCommit(projectId, { userId: req.user?.id ?? null });
    }
    res.status(created ? 201 : 200).json({ path, created });
  }),
);

/** DELETE /api/projects/:projectId/file?path=... */
router.delete('/api/projects/:projectId/file', handle('editor', async (projectId, req, res) => {
  const path = requirePath(req, res);
  if (path == null) return;
  // Snapshot-before-destroy (008-002): a delete is the one mutation whose
  // prior state is unrecoverable afterwards — commit any uncommitted window
  // first so the deleted content is always reachable in history.
  await commitNow(projectId, { userId: req.user?.id ?? null, label: `Snapshot before deleting ${path}` });
  await deleteProjectEntry(projectId, path);
  publishProjectEvent(projectId, { type: 'file_change', path, kind: 'delete' }, { userId: req.user?.id ?? null });
  res.json({ path, deleted: true });
}));

/**
 * POST /api/projects/:projectId/files/mkdir — body { path }. Creates an empty
 * folder; 201 when it was created, 200 { created: false } when it was already
 * there. The response echoes the CANONICAL path storage operated on.
 *
 * Deliberately publishes NO project event and schedules no commit (012-001):
 *  - git cannot track an empty directory, so `git status --porcelain` stays
 *    empty and commitNow short-circuits (history.js) — the commit would be a
 *    pure no-op;
 *  - `file_change` is file-shaped everywhere downstream (annotateUnseen above
 *    walks files only; the activity log renders per-file rows), so announcing
 *    a directory would insert a bogus activity row and mark a directory unseen.
 * Consequence, accepted: a second tab or a collaborator sees a new EMPTY
 * folder only on its next tree refresh. Live visibility needs a non-file event
 * kind and is deferred to story 012-004.
 */
router.post('/api/projects/:projectId/files/mkdir', handle('editor', async (projectId, req, res) => {
  const { path } = req.body ?? {};
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const { path: canonicalPath, created } = await createProjectDir(projectId, path);
  res.status(created ? 201 : 200).json({ path: canonicalPath, created });
}));

/** POST /api/projects/:projectId/files/move — body { from, to } */
router.post('/api/projects/:projectId/files/move', handle('editor', async (projectId, req, res) => {
  const { from, to } = req.body ?? {};
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  // Story 012-002: a pending edit already sitting at the destination is the
  // only copy of an agent's proposed document (pending edits never touch
  // disk), and the re-key would have to drop it to satisfy
  // UNIQUE(project_id, path). Check BEFORE the rename, so the request 409s
  // like any other destination conflict while the file is still in place.
  const clashes = findPendingEditConflicts(projectId, from, to);
  if (clashes.length > 0) {
    res.status(409).json({
      error: `A pending edit already exists at ${clashes[0]}`,
      code: 'conflict',
      paths: clashes,
    });
    return;
  }
  // Publish the CANONICAL paths storage reports back, never the request body:
  // './a.md', 'a//b' and 'dir/' all rename fine on disk but would key the DB
  // rewrite to a path that matches no row (story 012-002).
  const { from: fromPath, to: toPath } = await moveProjectEntry(projectId, from, to);
  // One identity-preserving event, not the delete+create pair that orphaned
  // every path-keyed consumer. The hub owns seen state, comments, pending
  // edits and the activity row — all in one transaction — so this route no
  // longer calls migrateSeenPaths itself. A folder move publishes exactly this
  // one event for the folder; descendants are implied by prefix.
  try {
    publishProjectEvent(projectId, {
      type: 'file_change', path: toPath, kind: 'moved', meta: { from: fromPath },
    }, { userId: req.user?.id ?? null });
  } catch (err) {
    // `moved` is the one kind whose persistence failure is not swallowed. The
    // rename has already committed, so the two systems now disagree: rename
    // back before surfacing the error, or the file sits at the new path while
    // every consumer still points at the old one.
    try {
      await moveProjectEntry(projectId, toPath, fromPath);
    } catch (undoErr) {
      console.error(
        `[files] Move rollback FAILED for project ${projectId}: content is on disk at ` +
        `${toPath} but comments/pending edits/seen markers still point at ${fromPath}.`,
        undoErr,
      );
      res.status(500).json({
        error: `Move failed and could not be undone: ${toPath} holds the content but ${fromPath} `
          + 'is still referenced by comments, pending edits and seen markers. Move it back by hand.',
        code: 'inconsistent_state',
      });
      return;
    }
    throw err;
  }
  res.json({ from: fromPath, to: toPath, moved: true });
}));

/**
 * POST /api/projects/:projectId/files/upload — multipart upload.
 * Form fields: `files` (one or more), optional `path` (target directory).
 *
 * Batch semantics are all-or-nothing: multer enforces the size limit while
 * the stream is still being parsed (protecting memory), so one oversize file
 * aborts the whole request before any file is written — mapped to a 413 by
 * the router error handler below. The webapp pre-checks sizes client-side so
 * valid files in a mixed drop still land (story 026).
 */
router.post(
  '/api/projects/:projectId/files/upload',
  uploadMiddleware,
  handle('editor', async (projectId, req, res) => {
    const files = req.files ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files in upload (use the "files" form field)' });
      return;
    }
    const targetDir = typeof req.body?.path === 'string' && req.body.path.length > 0
      ? req.body.path.replace(/\/+$/, '')
      : null;
    // Snapshot-before-destroy (008-002): an upload may overwrite existing
    // files wholesale — commit the pre-upload state first (no-op when clean).
    await commitNow(projectId, { userId: req.user?.id ?? null, label: 'Snapshot before upload' });
    const written = [];
    for (const file of files) {
      const relPath = targetDir ? `${targetDir}/${file.originalname}` : file.originalname;
      const { created } = await writeProjectFile(projectId, relPath, file.buffer);
      publishProjectEvent(projectId, {
        type: 'file_change',
        path: relPath,
        kind: created ? 'create' : 'update',
      }, { userId: req.user?.id ?? null });
      written.push({ path: relPath, size: file.buffer.length, created });
    }
    res.status(201).json({ files: written });
  }),
);

// Story-026 body-error mapping, shared with the org library (routes/uploads.js).
router.use(bodyErrorHandler);

export default router;
