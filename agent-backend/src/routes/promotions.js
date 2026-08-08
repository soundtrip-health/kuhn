// Story 011-004: the owner's promotion-approval queue. Suggestions are filed
// by the promote route (routes/projects.js) under the approval-required
// policy; every route here is owner-gated through requireOrgRole (suspension
// enforced, unknown orgs non-leaking). Decisions CLAIM the pending→decided
// transition with one atomic conditional UPDATE (fix MA3) — only a successful
// approve-claim reads the project file and copies it into the library
// (copy-on-approve), so rejected content structurally never reaches storage,
// ingestion, or FTS, even under concurrent owners.

import { Router } from 'express';

import { recordAuthEvent } from '../db/auth-events.js';
import {
  PROMOTION_STATUSES,
  claimPromotionDecision,
  getPromotionRequest,
  listPromotionRequests,
  revertPromotionToPending,
  setPromotionOrgDocument,
} from '../db/promotions.js';
import { publishOrgEvent, publishProjectEvent } from '../project-events.js';
import { StorageError, readProjectFile } from '../storage.js';
import { requireOrgRole } from './guards.js';
import { storeOrgDocument } from './org-library.js';

const router = Router();

/** Announce a decided request on both feeds (plan §4.4 shapes). */
function publishDecision(request) {
  publishProjectEvent(request.project_id, {
    type: 'promotion',
    requestId: request.id,
    path: request.path,
    status: request.status,
    decidedBy: request.decided_by,
    ...(request.decision_note ? { note: request.decision_note } : {}),
  });
  publishOrgEvent(request.org_id, {
    type: 'promotion_request',
    requestId: request.id,
    projectId: request.project_id,
    path: request.path,
    status: request.status,
    suggestedBy: request.suggested_by,
  });
}

/**
 * Shared decide plumbing: owner guard, id parse, body note, and the atomic
 * claim. Responds itself (400/403/404/409) and returns null on any refusal.
 * A failed claim distinguishes missing/cross-org (non-leaking 404) from
 * already-decided (409 — the concurrent-owner race, fix MA3).
 * @returns {Promise<{ctx: object, claimed: object, note: string|null}|null>}
 */
async function claimDecision(req, res, status) {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return null;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid promotion request id' });
    return null;
  }
  const rawNote = req.body?.note;
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null;
  const claimed = claimPromotionDecision({
    id, orgId: ctx.orgId, status, decidedBy: req.user.id, note,
  });
  if (!claimed) {
    if (!getPromotionRequest(ctx.orgId, id)) {
      res.status(404).json({ error: 'promotion request not found' });
    } else {
      res.status(409).json({ error: 'request already decided' });
    }
    return null;
  }
  return { ctx, claimed, note };
}

/** GET /api/orgs/:orgId/promotions?status= — the org's requests, newest first. */
router.get('/api/orgs/:orgId/promotions', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const status = typeof req.query.status === 'string' && req.query.status !== ''
    ? req.query.status
    : null;
  if (status !== null && !PROMOTION_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${PROMOTION_STATUSES.join(', ')}` });
    return;
  }
  res.json({ requests: listPromotionRequests(ctx.orgId, { status }) });
});

/**
 * POST /api/orgs/:orgId/promotions/:id/approve — body { note? }.
 * Claim first (atomic, fix MA3), copy-on-approve after: readProjectFile →
 * storeOrgDocument (the existing promote path, so dedupe + queueIngest +
 * doc_status SSE behave identically to a direct promote) → link the document.
 * A failed read/copy reverts the row to pending and 409s — the queue keeps
 * the request for a manual reject.
 */
router.post('/api/orgs/:orgId/promotions/:id/approve', async (req, res) => {
  const decision = await claimDecision(req, res, 'approved');
  if (!decision) return;
  const { ctx, claimed } = decision;

  let document;
  try {
    const buffer = await readProjectFile(claimed.project_id, claimed.path);
    ({ document } = await storeOrgDocument(ctx.orgId, buffer, {
      filename: claimed.path.split('/').pop(),
      title: claimed.title,
      source: 'project-promotion',
      sourceProjectId: claimed.project_id,
      createdBy: claimed.suggested_by,
    }));
  } catch (err) {
    revertPromotionToPending(claimed.id);
    if (err instanceof StorageError) {
      res.status(409).json({
        error: err.code === 'not_found' ? 'file no longer exists at that path' : err.message,
        code: err.code,
      });
      return;
    }
    throw err;
  }

  setPromotionOrgDocument(claimed.id, document.id);
  const request = getPromotionRequest(ctx.orgId, claimed.id);
  recordAuthEvent({
    type: 'promotion.approved',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: {
      requestId: request.id,
      projectId: request.project_id,
      path: request.path,
      orgDocumentId: document.id,
    },
  });
  publishDecision(request);
  res.json({ request });
});

/**
 * POST /api/orgs/:orgId/promotions/:id/reject — body { note? }. Same atomic
 * claim; no file access — nothing was ever copied for a pending request.
 */
router.post('/api/orgs/:orgId/promotions/:id/reject', async (req, res) => {
  const decision = await claimDecision(req, res, 'rejected');
  if (!decision) return;
  const { ctx, claimed } = decision;

  const request = getPromotionRequest(ctx.orgId, claimed.id);
  recordAuthEvent({
    type: 'promotion.rejected',
    actorUserId: req.user.id,
    orgId: ctx.orgId,
    meta: { requestId: request.id, projectId: request.project_id, path: request.path },
  });
  publishDecision(request);
  res.json({ request });
});

export default router;
