// Story 008-001: pending-edit rows for suggestion mode. Pure SQLite access —
// one row per (project, path); the diff/apply math and the accept/reject
// orchestration live in src/pending-edits.js. Synchronous (querySync) like
// file-activity.js so the service layer can call it from sync refresh code.

import { querySync } from '../db.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Create or coalesce a pending edit for (projectId, path). On conflict the
 * proposed content (and attribution) is replaced; base_content stays the disk
 * content captured by the FIRST proposal — the user reviews against what they
 * last saw, not against intermediate proposals.
 * @returns {object} The inserted/updated row
 */
export function upsertPendingEdit(projectId, {
  path, baseContent, baseHash, baseMissing = false, proposedContent, agentSlug = null, jobId = null,
}) {
  const { rows } = querySync(
    `INSERT INTO pending_edits
       (project_id, path, base_content, base_hash, base_missing, proposed_content, agent_slug, job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, path) DO UPDATE SET
       proposed_content = excluded.proposed_content,
       agent_slug = excluded.agent_slug,
       job_id = excluded.job_id,
       updated_at = ${NOW}
     RETURNING *`,
    [projectId, path, baseContent, baseHash, baseMissing ? 1 : 0, proposedContent, agentSlug, jobId],
  );
  return rows[0];
}

/** @returns {object|undefined} */
export function getPendingEdit(projectId, id) {
  const { rows } = querySync(
    'SELECT * FROM pending_edits WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  return rows[0];
}

/** @returns {object|undefined} */
export function getPendingEditByPath(projectId, path) {
  const { rows } = querySync(
    'SELECT * FROM pending_edits WHERE project_id = $1 AND path = $2',
    [projectId, path],
  );
  return rows[0];
}

/** All pending edits for a project (optionally one path), oldest first. */
export function listPendingEdits(projectId, { path = null } = {}) {
  const { rows } = querySync(
    `SELECT * FROM pending_edits
     WHERE project_id = $1 AND ($2 IS NULL OR path = $2)
     ORDER BY created_at, id`,
    [projectId, path],
  );
  return rows;
}

/**
 * Update mutable fields (rebase, partial accept/reject, staleness). Only
 * provided keys change.
 * @returns {object|undefined} The updated row
 */
export function updatePendingEdit(id, fields) {
  const columns = {
    baseContent: 'base_content',
    baseHash: 'base_hash',
    baseMissing: 'base_missing',
    proposedContent: 'proposed_content',
    stale: 'stale',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      params.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return undefined;
  params.push(id);
  const { rows } = querySync(
    `UPDATE pending_edits SET ${sets.join(', ')}, updated_at = ${NOW}
     WHERE id = $${params.length}
     RETURNING *`,
    params,
  );
  return rows[0];
}

export function deletePendingEdit(id) {
  querySync('DELETE FROM pending_edits WHERE id = $1', [id]);
}
