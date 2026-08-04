// Epic 013 stories 001/002: the guest (external reviewer) HTTP surface.
// Mounted BEFORE session() — reviewers are anonymous to the member stack, and
// every route here lives under /api/review/* so the allowlist holds by
// construction: a guest request carries only kuhn_review_session, which
// session() cannot see, so every other /api route 401s before any handler.
//
// The session-bearing routes take NO path or project parameters — the
// principal's projectId/path come from the review_links row (review-auth.js),
// so there is no traversal surface and a moved document is transparently
// re-pointed. Mode gates: view < comment < edit (see the §2.4 matrix, pinned
// by review-matrix.test.js).

import { Router } from 'express';
import express from 'express';
import { extname } from 'node:path';

import { config } from '../config.js';
import {
  addReply,
  createThread,
  deleteOwn,
  listThreads,
  setResolved,
  updateAnchor,
} from '../db/comments.js';
import {
  claimReviewLink,
  lookupReviewLink,
  recordReviewerEditEvent,
} from '../db/review-links.js';
import { commitNow, scheduleCommit } from '../history.js';
import { publishProjectEvent } from '../project-events.js';
import { REVIEW_COOKIE, reviewerPrincipal, reviewerSession } from '../review-auth.js';
import { StorageError, readProjectFile, writeProjectFile } from '../storage.js';

const router = Router();

const STATUS_BY_CODE = {
  not_found: 404,
  outside_root: 403,
  forbidden: 403,
  invalid_path: 400,
  invalid_name: 400,
  too_large: 413,
  conflict: 409,
};

// Subset of the files-route map — a review link covers one document.
const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.typ': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
};

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(STATUS_BY_CODE[err.code] ?? 500).json({ error: err.message, code: err.code });
      } else {
        console.error('[review] Unexpected error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };
}

/** Mode gate for session-bearing routes (runs after reviewerSession). */
const requireMode = (...modes) => (req, res, next) => {
  if (!modes.includes(req.reviewer.mode)) {
    res.status(403).json({
      error: `this review link is ${req.reviewer.mode}-only`,
      code: 'mode_forbidden',
    });
    return;
  }
  next();
};

const docTitleOf = (path) => path.split('/').pop();

/** The guest equivalent of /api/auth/me — everything the review shell needs
 *  (projectId only to build the Yjs room name client-side). */
const contextOf = (reviewer) => ({
  projectId: reviewer.projectId,
  path: reviewer.path,
  mode: reviewer.mode,
  name: reviewer.name,
  docTitle: docTitleOf(reviewer.path),
  expiresAt: reviewer.expiresAt,
});

// Same attribute set as the member session cookie (routes/auth.js), except the
// path MUST be '/' (not /api/review) — the cookie has to ride the
// /yjs-websocket/ upgrade too.
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.auth.appUrl.startsWith('https://'),
  path: '/',
});

/**
 * Find comment `id` among the reviewer's document's threads. Thread ops go
 * through this so a reviewer can never touch another doc's comments: anything
 * outside their doc is a plain 404 (no existence leak).
 * @returns {{root: object, comment: object}|null}
 */
function findInDocThreads(projectId, path, id) {
  for (const thread of listThreads(projectId, { path })) {
    if (thread.id === id) return { root: thread, comment: thread };
    const reply = thread.replies.find((r) => r.id === id);
    if (reply) return { root: thread, comment: reply };
  }
  return null;
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

/** Locate :id within the reviewer's doc or 404. */
function requireDocComment(req, res) {
  const id = requireCommentId(req, res);
  if (id == null) return null;
  const found = findInDocThreads(req.reviewer.projectId, req.reviewer.path, id);
  if (!found) {
    res.status(404).json({ error: `No comment ${id} on this document` });
    return null;
  }
  return { id, ...found };
}

/** Comment feed events carry reviewLinkId in place of userId so member tabs
 *  refresh AND can attribute the mutation to the external reviewer. */
function commentEvent(projectId, reviewer, { action, id, rootId }) {
  publishProjectEvent(projectId, {
    type: 'comment', action, path: reviewer.path, id, rootId, agent: null,
    reviewLinkId: reviewer.linkId,
  });
}

// ---- Pre-session (token-bearing, no cookie required) -------------------------

/**
 * POST /api/review/lookup — body { token }. Drives the claim page: name prompt
 * (unclaimed), the three refusal screens (claimed/expired/revoked), or —
 * when the caller's existing cookie already resolves to this same link —
 * { state: 'yours', context } so reopening the URL skips re-claim.
 */
router.post('/api/review/lookup', handle(async (req, res) => {
  const { token } = req.body ?? {};
  const found = lookupReviewLink(typeof token === 'string' ? token : '');
  if (!found) {
    res.status(404).json({ error: 'unknown review link', code: 'link_not_found' });
    return;
  }
  const principal = reviewerPrincipal(req);
  if (principal && principal.linkId === found.link.id) {
    res.json({ state: 'yours', context: contextOf(principal) });
    return;
  }
  res.json({
    state: found.state,
    mode: found.link.mode,
    docTitle: docTitleOf(found.link.path),
    reviewerName: found.link.reviewerName,
  });
}));

/**
 * POST /api/review/claim — body { token, name }. Atomic single-claim: opens
 * the reviewer session, sets the cookie, returns { context }. Refusals are
 * three distinct, human-readable states (story 001 AC).
 */
router.post('/api/review/claim', handle(async (req, res) => {
  const { token, name } = req.body ?? {};
  if (typeof token !== 'string' || token.length === 0) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  const result = claimReviewLink(token, name); // throws invalid_name → 400
  if (!result.ok) {
    const refusal = {
      not_found: [404, 'link_not_found', 'unknown review link'],
      claimed: [409, 'link_claimed', 'this review link is already in use'],
      expired: [410, 'link_expired', 'this review link has expired'],
      revoked: [410, 'link_revoked', 'this review link was revoked'],
    }[result.reason];
    res.status(refusal[0]).json({ error: refusal[2], code: refusal[1] });
    return;
  }
  const { link } = result;
  res.cookie(REVIEW_COOKIE, result.cookieValue, {
    ...cookieOptions(),
    expires: new Date(result.expiresAt),
  });
  publishProjectEvent(link.projectId, {
    type: 'review_link', action: 'claim',
    linkId: link.id, path: link.path, mode: link.mode, name: link.reviewerName,
  });
  res.json({
    context: {
      projectId: link.projectId,
      path: link.path,
      mode: link.mode,
      name: link.reviewerName,
      docTitle: docTitleOf(link.path),
      expiresAt: link.expiresAt,
    },
  });
}));

// ---- Session-bearing (all pass reviewerSession) ------------------------------

/** GET /api/review/context — the reviewer's scope; re-fetched after a 4002
 *  room move so the client learns the document's new path. */
router.get('/api/review/context', reviewerSession, handle(async (req, res) => {
  res.json(contextOf(req.reviewer));
}));

/** GET /api/review/file — the linked document's bytes. No path parameter
 *  exists, so there is no traversal surface. All modes. */
router.get('/api/review/file', reviewerSession, handle(async (req, res) => {
  const buf = await readProjectFile(req.reviewer.projectId, req.reviewer.path);
  res.set('Content-Type',
    CONTENT_TYPES[extname(req.reviewer.path).toLowerCase()] ?? 'application/octet-stream');
  res.send(buf);
}));

// Same request-time-limit rationale as the member file route.
const rawBody = (req, res, next) =>
  express.raw({ type: () => true, limit: config.storage.maxFileBytes })(req, res, next);

/**
 * PUT /api/review/file[?checkpoint=1] — edit mode only; raw body. Mirrors the
 * member autosave path (routes/files.js) including the deliberate
 * no-feed-per-autosave choice, with two reviewer differences (013 decision 4):
 * a debounced file_events row (kind 'update', review_link_id — at most one per
 * link per 5-minute window) plus, on the same cadence, a live non-file_change
 * feed event so member tabs hear about external writes without evicting the
 * reviewer's own room. Version attribution threads { reviewer } meta;
 * ?checkpoint=1 additionally sets reviewerCheckpoint so an explicit reviewer
 * save is never relabeled by agent meta pending in the same window.
 */
router.put('/api/review/file', reviewerSession, requireMode('edit'), rawBody,
  handle(async (req, res) => {
    const { projectId, path, linkId, mode, name } = req.reviewer;
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: 'Send the raw file content as the request body' });
      return;
    }
    const { created } = await writeProjectFile(projectId, path, req.body);
    if (req.query.checkpoint === '1') {
      void commitNow(projectId, {
        reviewer: { linkId, name }, reviewerCheckpoint: true, label: `Save ${path}`,
      });
    } else {
      scheduleCommit(projectId, { reviewer: { linkId, name } });
    }
    if (recordReviewerEditEvent(projectId, linkId, path)) {
      publishProjectEvent(projectId, {
        type: 'review_link', action: 'edit', linkId, path, mode, name,
      });
    }
    res.status(created ? 201 : 200).json({ path, created });
  }));

/** GET /api/review/comments — the linked document's threads. All modes
 *  (view included, per story 001). */
router.get('/api/review/comments', reviewerSession, handle(async (req, res) => {
  res.json({ threads: listThreads(req.reviewer.projectId, { path: req.reviewer.path }) });
}));

/**
 * POST /api/review/comments — comment/edit modes. Path is forced to the
 * reviewer's document (any body path is ignored); authored as
 * { userId: null, reviewLinkId } (epic 013 attribution model).
 */
router.post('/api/review/comments', reviewerSession, requireMode('comment', 'edit'),
  handle(async (req, res) => {
    const { body, anchor = null } = req.body ?? {};
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'a non-empty body is required' });
      return;
    }
    if (anchor != null && typeof anchor.quote !== 'string') {
      res.status(400).json({ error: 'anchor.quote must be a string when an anchor is given' });
      return;
    }
    const reviewer = req.reviewer;
    const thread = createThread(reviewer.projectId, {
      path: reviewer.path,
      body: body.trim(),
      quote: anchor?.quote ?? null,
      start: Number.isInteger(anchor?.start) ? anchor.start : null,
      end: Number.isInteger(anchor?.end) ? anchor.end : null,
      userId: null,
      reviewLinkId: reviewer.linkId,
    });
    commentEvent(reviewer.projectId, reviewer, { action: 'create', id: thread.id, rootId: thread.id });
    res.status(201).json(thread);
  }));

/** POST /api/review/comments/:id/replies — comment/edit; any thread on the
 *  reviewer's document (threads elsewhere are a 404). */
router.post('/api/review/comments/:id/replies', reviewerSession, requireMode('comment', 'edit'),
  handle(async (req, res) => {
    const found = requireDocComment(req, res);
    if (found == null) return;
    const { body } = req.body ?? {};
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'a non-empty body is required' });
      return;
    }
    const reviewer = req.reviewer;
    const reply = addReply(reviewer.projectId, found.root.id, {
      body: body.trim(), userId: null, reviewLinkId: reviewer.linkId,
    });
    commentEvent(reviewer.projectId, reviewer, { action: 'reply', id: reply.id, rootId: found.root.id });
    res.status(201).json(reply);
  }));

/**
 * Resolve/reopen — comment/edit, OWN threads only (root minted by this link),
 * else 403. Stricter than members, who may resolve anything; that stays
 * member-route behavior. Writes resolved_by_link_id, not resolved_by.
 */
function setResolvedRoute(resolved, action) {
  return handle(async (req, res) => {
    const found = requireDocComment(req, res);
    if (found == null) return;
    const reviewer = req.reviewer;
    if (found.root.reviewLinkId !== reviewer.linkId) {
      res.status(403).json({ error: 'reviewers can only resolve their own threads' });
      return;
    }
    const thread = setResolved(reviewer.projectId, found.id, resolved, { reviewLinkId: reviewer.linkId });
    commentEvent(reviewer.projectId, reviewer, { action, id: found.id, rootId: found.id });
    res.json(thread);
  });
}

router.post('/api/review/comments/:id/resolve', reviewerSession, requireMode('comment', 'edit'),
  setResolvedRoute(true, 'resolve'));
router.post('/api/review/comments/:id/reopen', reviewerSession, requireMode('comment', 'edit'),
  setResolvedRoute(false, 'reopen'));

/** DELETE /api/review/comments/:id — comment/edit, own only (exact
 *  review_link_id match in deleteOwn — a reviewer can never delete member or
 *  agent comments, nor another link's). */
router.delete('/api/review/comments/:id', reviewerSession, requireMode('comment', 'edit'),
  handle(async (req, res) => {
    const found = requireDocComment(req, res);
    if (found == null) return;
    const reviewer = req.reviewer;
    const { rootId } = deleteOwn(reviewer.projectId, found.id, { reviewLinkId: reviewer.linkId });
    commentEvent(reviewer.projectId, reviewer, { action: 'delete', id: found.id, rootId });
    res.json({ ok: true });
  }));

/**
 * PATCH /api/review/comments/:id/anchor — EDIT mode only: in view/comment
 * modes anchors are maintained by member tabs and the reviewer client gates
 * its writebacks off. No feed event (presentation state, as on the member
 * route).
 */
router.patch('/api/review/comments/:id/anchor', reviewerSession, requireMode('edit'),
  handle(async (req, res) => {
    const found = requireDocComment(req, res);
    if (found == null) return;
    const { quote, start, end, orphaned } = req.body ?? {};
    if (quote != null && typeof quote !== 'string') {
      res.status(400).json({ error: 'quote must be a string' });
      return;
    }
    if ((start != null && !Number.isInteger(start)) || (end != null && !Number.isInteger(end))) {
      res.status(400).json({ error: 'start and end must be integers' });
      return;
    }
    res.json(updateAnchor(req.reviewer.projectId, found.id, {
      quote, start, end, orphaned: orphaned == null ? null : orphaned === true,
    }));
  }));

export default router;
