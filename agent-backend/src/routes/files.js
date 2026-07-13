// Story 018: HTTP surface of the storage service — project tree, file CRUD,
// move, and multipart upload. Consumed by the webapp (stories 013/014).
// All path safety lives in src/storage.js; these handlers only translate
// HTTP <-> storage calls and map StorageError codes to status codes.

import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { extname } from 'node:path';

import { config } from '../config.js';
import { unseenPaths, migrateSeenPaths } from '../db/file-activity.js';
import { publishProjectEvent } from '../project-events.js';
import {
  StorageError,
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
router.get('/api/projects/:projectId/files', handle(async (projectId, req, res) => {
  const tree = await listProjectTree(projectId, typeof req.query.path === 'string' ? req.query.path : '.');
  const unseen = unseenPaths(projectId, req.user?.id ?? null);
  if (unseen.size > 0) annotateUnseen(tree, unseen);
  res.json({ tree });
}));

/** GET /api/projects/:projectId/file?path=... — raw file content */
router.get('/api/projects/:projectId/file', handle(async (projectId, req, res) => {
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
  handle(async (projectId, req, res) => {
    const path = requirePath(req, res);
    if (path == null) return;
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: 'Send the raw file content as the request body' });
      return;
    }
    const { created } = await writeProjectFile(projectId, path, req.body);
    res.status(created ? 201 : 200).json({ path, created });
  }),
);

/** DELETE /api/projects/:projectId/file?path=... */
router.delete('/api/projects/:projectId/file', handle(async (projectId, req, res) => {
  const path = requirePath(req, res);
  if (path == null) return;
  await deleteProjectEntry(projectId, path);
  publishProjectEvent(projectId, { type: 'file_change', path, kind: 'delete' });
  res.json({ path, deleted: true });
}));

/** POST /api/projects/:projectId/files/move — body { from, to } */
router.post('/api/projects/:projectId/files/move', handle(async (projectId, req, res) => {
  const { from, to } = req.body ?? {};
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  await moveProjectEntry(projectId, from, to);
  // Seen state follows the file (005-002); the move surfaces on the feed as
  // the same delete+create pair the agent move_file tool emits.
  migrateSeenPaths(projectId, from, to);
  publishProjectEvent(projectId, { type: 'file_change', path: from, kind: 'delete' });
  publishProjectEvent(projectId, { type: 'file_change', path: to, kind: 'create' });
  res.json({ from, to, moved: true });
}));

const MAX_UPLOAD_FILES = 20;

// Read limits at request time, not import time, so STORAGE_MAX_FILE_BYTES
// overrides (and tests that adjust config) always match storage.js.
function uploadMiddleware(req, res, next) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.storage.maxFileBytes, files: MAX_UPLOAD_FILES },
  }).array('files')(req, res, next);
}

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
  handle(async (projectId, req, res) => {
    const files = req.files ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files in upload (use the "files" form field)' });
      return;
    }
    const targetDir = typeof req.body?.path === 'string' && req.body.path.length > 0
      ? req.body.path.replace(/\/+$/, '')
      : null;
    const written = [];
    for (const file of files) {
      const relPath = targetDir ? `${targetDir}/${file.originalname}` : file.originalname;
      const { created } = await writeProjectFile(projectId, relPath, file.buffer);
      publishProjectEvent(projectId, {
        type: 'file_change',
        path: relPath,
        kind: created ? 'create' : 'update',
      });
      written.push({ path: relPath, size: file.buffer.length, created });
    }
    res.status(201).json({ files: written });
  }),
);

// Errors thrown by body-parsing middleware (multer, express.raw) never reach
// handle()'s catch — without this handler they fall through to Express's
// default HTML 500/413. Map them to the same { error, code } shape as
// StorageError responses (story 026).
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `File exceeds ${config.storage.maxFileBytes} bytes; nothing was uploaded`,
        code: 'too_large',
      });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        error: `Too many files in one upload (max ${MAX_UPLOAD_FILES})`,
        code: 'too_many_files',
      });
      return;
    }
    res.status(400).json({ error: err.message, code: 'upload_error' });
    return;
  }
  // express.raw() body-size rejection on PUT /file
  if (err?.type === 'entity.too.large') {
    res.status(413).json({
      error: `Content exceeds ${config.storage.maxFileBytes} bytes`,
      code: 'too_large',
    });
    return;
  }
  next(err);
});

export default router;
