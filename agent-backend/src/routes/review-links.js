// Epic 013 story 003: member-facing review-link management — mint, list,
// revoke. Mounted with the tenant routers AFTER session(), behind
// requireProjectRole (404 on non-membership, like routes/comments.js — don't
// leak existence). Guests never get here: they carry only
// kuhn_review_session, which session() cannot see → 401 upstream.
//
// Roles (story 010-003): minting and revoking a link hand out / withdraw
// document access, so they need editor; listing is a viewer read. The
// thresholds live in handle()'s minRole argument and nowhere else.

import { Router } from 'express';

import {
  REVIEW_MODES,
  createReviewLink,
  listReviewLinks,
  revokeReviewLink,
} from '../db/review-links.js';
import { publishProjectEvent } from '../project-events.js';
import { StorageError, readProjectFile } from '../storage.js';
import { CLOSE_LINK_REVOKED, closeReviewerConnections } from '../yjs-websocket.js';
import { requireProjectRole } from './guards.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
  forbidden: 403,
  invalid_path: 400,
  invalid_mode: 400,
  too_large: 413,
  conflict: 409,
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
        console.error('[review-links] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/**
 * POST /api/projects/:projectId/review-links — body { path, mode, ttlMs? }.
 * Validates the document exists (404 otherwise), mints, and returns
 * { url, link }. The raw token appears ONLY in this response — the row keeps
 * its hash. URL built from req.protocol/host like magic links (trust proxy is
 * set in index.js, so deployed links mint as https on the public host).
 */
router.post('/api/projects/:projectId/review-links', handle('editor', async (projectId, req, res) => {
  const { path, mode, ttlMs } = req.body ?? {};
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  if (!REVIEW_MODES.includes(mode)) {
    res.status(400).json({ error: `mode must be one of ${REVIEW_MODES.join(', ')}` });
    return;
  }
  await readProjectFile(projectId, path); // not_found → 404: only real docs get links
  const { token, link } = createReviewLink({
    projectId, path, mode, createdBy: req.user.id,
    ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined,
  });
  publishProjectEvent(projectId, {
    type: 'review_link', action: 'mint',
    linkId: link.id, path: link.path, mode: link.mode,
  }, { userId: req.user.id });
  res.status(201).json({
    url: `${req.protocol}://${req.get('host')}/review/${token}`,
    link,
  });
}));

/** GET /api/projects/:projectId/review-links?path=&includeRevoked= — the
 *  active-links panel (per-doc with ?path=, per-project rollup without). */
router.get('/api/projects/:projectId/review-links', handle('viewer', async (projectId, req, res) => {
  const path = typeof req.query.path === 'string' && req.query.path.length > 0
    ? req.query.path : null;
  const includeRevoked = req.query.includeRevoked === '1' || req.query.includeRevoked === 'true';
  res.json({ links: listReviewLinks(projectId, { path, includeRevoked }) });
}));

/**
 * POST /api/projects/:projectId/review-links/:id/revoke — one request/socket
 * cycle (story 003 AC): the DB revoke kills the sessions (the next guest
 * request 401s — per-request check, no cache), then the reviewer registry
 * closes that credential's live sockets with 4003, then the feed hears about
 * it. Idempotent on an already-revoked link.
 */
router.post('/api/projects/:projectId/review-links/:id/revoke', handle('editor', async (projectId, req, res) => {
  const linkId = parseInt(req.params.id);
  if (Number.isNaN(linkId)) {
    res.status(400).json({ error: 'link id must be a number' });
    return;
  }
  const link = revokeReviewLink(projectId, linkId, { revokedBy: req.user.id });
  if (!link) {
    res.status(404).json({ error: 'review link not found' });
    return;
  }
  closeReviewerConnections(linkId, { code: CLOSE_LINK_REVOKED, reason: 'Link revoked' });
  publishProjectEvent(projectId, {
    type: 'review_link', action: 'revoke',
    linkId: link.id, path: link.path, mode: link.mode, name: link.reviewerName,
  }, { userId: req.user.id });
  res.json({ link });
}));

export default router;
