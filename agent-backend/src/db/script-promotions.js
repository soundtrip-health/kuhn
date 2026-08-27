// Issue #68: script promotion requests — "promote this project script into
// the org script library" under the approval-required policy. Parallels
// db/promotions.js (story 011-004) rather than reusing it: that table's
// approve path is org-library-document-specific. A request row holds only
// (project_id, path) plus intent — never code — so rejected scripts never
// enter the library (copy-on-approve).

import { querySync, transaction } from '../db.js';

const JOINED_SELECT = `
  SELECT spr.id, spr.org_id, spr.project_id, p.name AS project_name, spr.path,
         spr.title, spr.note, spr.language, spr.target_script_id,
         ts.slug AS target_script_slug, ts.title AS target_script_title,
         spr.suggested_by, u.email AS suggested_by_email,
         spr.status, spr.decided_by, spr.decided_at, spr.decision_note,
         spr.org_script_id, spr.created_at
  FROM script_promotion_requests spr
  JOIN projects p ON p.id = spr.project_id
  LEFT JOIN org_scripts ts ON ts.id = spr.target_script_id
  LEFT JOIN users u ON u.id = spr.suggested_by`;

/**
 * File a script promotion. A PENDING request for the same (project, path) is
 * returned instead of duplicated; re-suggesting after a rejection files a
 * fresh row (history preserved).
 * @returns {{ request: object, existing: boolean }}
 */
export function createScriptPromotion({
  orgId, projectId, path, language, title = null, note = null,
  targetScriptId = null, suggestedBy = null,
}) {
  return transaction(() => {
    const { rows: pending } = querySync(
      `${JOINED_SELECT}
       WHERE spr.project_id = $1 AND spr.path = $2 AND spr.status = 'pending'`,
      [projectId, path],
    );
    if (pending[0]) return { request: pending[0], existing: true };
    const { rows } = querySync(
      `INSERT INTO script_promotion_requests
         (org_id, project_id, path, language, title, note, target_script_id, suggested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [orgId, projectId, path, language, title, note, targetScriptId, suggestedBy],
    );
    return { request: getScriptPromotion(orgId, rows[0].id), existing: false };
  });
}

/** An org's script promotions, newest first, optionally filtered by status. */
export function listScriptPromotions(orgId, { status = null } = {}) {
  const { rows } = querySync(
    `${JOINED_SELECT}
     WHERE spr.org_id = $1 AND ($2 IS NULL OR spr.status = $2)
     ORDER BY spr.created_at DESC, spr.id DESC`,
    [orgId, status],
  );
  return rows;
}

/** One request — org-scoped lookup so a request id can't cross tenants. */
export function getScriptPromotion(orgId, id) {
  const { rows } = querySync(
    `${JOINED_SELECT} WHERE spr.org_id = $1 AND spr.id = $2`,
    [orgId, id],
  );
  return rows[0] ?? null;
}

/**
 * CLAIM a decision: one atomic conditional UPDATE guarded on
 * status='pending' — under concurrent owners exactly one claim succeeds.
 * The approve route reads and stores the code only AFTER a successful claim.
 * @returns {object|null} the claimed (raw) row, or null
 */
export function claimScriptPromotionDecision({ id, orgId, status, decidedBy, note = null }) {
  const { rows } = querySync(
    `UPDATE script_promotion_requests
     SET status = $3, decided_by = $4,
         decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), decision_note = $5
     WHERE id = $1 AND org_id = $2 AND status = 'pending'
     RETURNING *`,
    [id, orgId, status, decidedBy, note],
  );
  return rows[0] ?? null;
}

/**
 * Roll a claimed approval back to pending (the copy failed, or the reviewed
 * content drifted). Single UPDATE so the row is never half-decided.
 */
export function revertScriptPromotionToPending(id) {
  querySync(
    `UPDATE script_promotion_requests
     SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = $1`,
    [id],
  );
}

/** Link an approved request to the org script its code became. */
export function setScriptPromotionResult(id, orgScriptId) {
  querySync(
    'UPDATE script_promotion_requests SET org_script_id = $2 WHERE id = $1',
    [id, orgScriptId],
  );
}
