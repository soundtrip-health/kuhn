// Story 011-004: promotion requests — an editor's "suggest for the org
// library" under the approval-required policy. A request row holds only
// (project_id, path), never bytes or an org_documents row: nothing touches
// storage, ingestion, or FTS until an owner approves (copy-on-approve).
// Synchronous (querySync), matching the other db/ modules.

import { querySync, transaction } from '../db.js';

export const PROMOTION_STATUSES = ['pending', 'approved', 'rejected'];

// Client shape (webapp api.ts PromotionRequest): the raw row joined with the
// project name and the suggester's email. LEFT JOIN on users — suggested_by
// is SET NULL when the account goes away, and the request must survive that.
const JOINED_SELECT = `
  SELECT pr.id, pr.org_id, pr.project_id, p.name AS project_name, pr.path,
         pr.title, pr.note, pr.suggested_by, u.email AS suggested_by_email,
         pr.status, pr.decided_by, pr.decided_at, pr.decision_note,
         pr.org_document_id, pr.created_at
  FROM promotion_requests pr
  JOIN projects p ON p.id = pr.project_id
  LEFT JOIN users u ON u.id = pr.suggested_by`;

/**
 * File a promotion suggestion. A PENDING request for the same
 * (project, path) is returned instead of duplicated — re-suggesting after a
 * rejection creates a fresh row (history preserved).
 * @returns {{ request: object, existing: boolean }}
 */
export function createPromotionRequest({
  orgId, projectId, path, title = null, note = null, suggestedBy = null,
}) {
  return transaction(() => {
    const { rows: pending } = querySync(
      `${JOINED_SELECT}
       WHERE pr.project_id = $1 AND pr.path = $2 AND pr.status = 'pending'`,
      [projectId, path],
    );
    if (pending[0]) return { request: pending[0], existing: true };
    const { rows } = querySync(
      `INSERT INTO promotion_requests (org_id, project_id, path, title, note, suggested_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [orgId, projectId, path, title, note, suggestedBy],
    );
    return { request: getPromotionRequest(orgId, rows[0].id), existing: false };
  });
}

/** An org's promotion requests, newest first, optionally filtered by status. */
export function listPromotionRequests(orgId, { status = null } = {}) {
  const { rows } = querySync(
    `${JOINED_SELECT}
     WHERE pr.org_id = $1 AND ($2 IS NULL OR pr.status = $2)
     ORDER BY pr.created_at DESC, pr.id DESC`,
    [orgId, status],
  );
  return rows;
}

/** One request — org-scoped lookup so a request id can't cross tenants. */
export function getPromotionRequest(orgId, id) {
  const { rows } = querySync(
    `${JOINED_SELECT} WHERE pr.org_id = $1 AND pr.id = $2`,
    [orgId, id],
  );
  return rows[0] ?? null;
}

/**
 * CLAIM a decision (fix MA3): one atomic conditional UPDATE, guarded on
 * status='pending' — the consumeAuthToken discipline. Under concurrent
 * owners exactly one claim succeeds; the loser gets null and no side effect.
 * The approve route copies the file only AFTER a successful claim, which is
 * what guarantees rejected content never reaches storage or FTS.
 * @returns {object|null} the claimed (raw, un-joined) row, or null when the
 *   request is missing, another org's, or already decided
 */
export function claimPromotionDecision({ id, orgId, status, decidedBy, note = null }) {
  const { rows } = querySync(
    `UPDATE promotion_requests
     SET status = $3, decided_by = $4,
         decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), decision_note = $5
     WHERE id = $1 AND org_id = $2 AND status = 'pending'
     RETURNING *`,
    [id, orgId, status, decidedBy, note],
  );
  return rows[0] ?? null;
}

/**
 * Roll a claimed approval back to pending (the copy-on-approve read/write
 * failed — e.g. the file was deleted since the suggestion). Single UPDATE so
 * the row is never half-decided.
 */
export function revertPromotionToPending(id) {
  querySync(
    `UPDATE promotion_requests
     SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = $1`,
    [id],
  );
}

/** Link an approved request to the library document its bytes became. */
export function setPromotionOrgDocument(id, orgDocumentId) {
  querySync(
    'UPDATE promotion_requests SET org_document_id = $2 WHERE id = $1',
    [id, orgDocumentId],
  );
}
