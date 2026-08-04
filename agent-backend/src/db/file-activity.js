// Story 005-002: persisted file activity + per-user seen state. The write
// path is the project-events hub (publishProjectEvent persists every
// file_change it accepts), so agent writes, uploads, deletes, and renames all
// land here through the same chokepoint that feeds the live SSE feed.
// Synchronous (querySync) because the hub publishes from sync code.

import { querySync } from '../db.js';
import { config } from '../config.js';

/** Kind-specific JSON sidecar; a corrupt value degrades to null, never throws. */
function parseMeta(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Append one file event and prune the project's log to the configured cap.
 * `meta` is a plain object (story 012-002: a 'moved' row stores
 * `{ from: <old path> }`; `path` is always the NEW path) stored as JSON.
 * `reviewLinkId` (epic 013) attributes an external reviewer's debounced edit
 * event; member/agent rows leave it NULL.
 * @param {{ path: string, kind: string, agentSlug?: string|null, jobId?: number|null, userId?: number|null, reviewLinkId?: number|null, meta?: object|null }} event
 */
export function recordFileEvent(
  projectId,
  { path, kind, agentSlug = null, jobId = null, userId = null, reviewLinkId = null, meta = null },
) {
  querySync(
    `INSERT INTO file_events (project_id, path, kind, agent_slug, job_id, user_id,
                              review_link_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [projectId, path, kind, agentSlug, jobId, userId, reviewLinkId,
     meta == null ? null : JSON.stringify(meta)],
  );
  querySync(
    `DELETE FROM file_events
     WHERE project_id = $1 AND id NOT IN (
       SELECT id FROM file_events
       WHERE project_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     )`,
    [projectId, config.fileActivity.maxEventsPerProject],
  );
}

/** Recent events for a project, newest first, optionally after `since`.
 *  Reviewer-attributed rows (epic 013) carry review_link_id plus the link's
 *  reviewer_name so the activity feed can badge external origin. */
export function listFileActivity(projectId, { since = null, limit = 200 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit) || 200, 1), 1000);
  const { rows } = querySync(
    `SELECT e.id, e.path, e.kind, e.meta, e.agent_slug, e.job_id, e.user_id,
            e.review_link_id, rl.reviewer_name AS reviewer_name, e.created_at
     FROM file_events e
     LEFT JOIN review_links rl ON rl.id = e.review_link_id
     WHERE e.project_id = $1 AND ($2 IS NULL OR e.created_at > $2)
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ${cap}`,
    [projectId, since],
  );
  return rows.map((r) => ({ ...r, meta: parseMeta(r.meta) }));
}

/** Upsert the user's seen marker for a path (idempotent; refreshes seen_at). */
export function markSeen(userId, projectId, path) {
  querySync(
    `INSERT INTO file_seen (user_id, project_id, path)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, project_id, path)
     DO UPDATE SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [userId, projectId, path],
  );
}

/**
 * Paths whose latest surviving (non-delete) event postdates the user's seen
 * marker — the per-user "new/changed" set. Paths whose files no longer exist
 * are harmless here: callers only apply flags to nodes present in the tree.
 * @returns {Set<string>}
 */
export function unseenPaths(projectId, userId) {
  if (userId == null) return new Set();
  const { rows } = querySync(
    `SELECT e.path
     FROM file_events e
     WHERE e.project_id = $1 AND e.kind != 'delete'
     GROUP BY e.path
     HAVING MAX(e.created_at) > COALESCE(
       (SELECT s.seen_at FROM file_seen s
        WHERE s.user_id = $2 AND s.project_id = $1 AND s.path = e.path),
       '')`,
    [projectId, userId],
  );
  return new Set(rows.map((r) => r.path));
}

/**
 * Re-key seen markers when an entry moves, so seen state follows the file
 * (and directory moves carry their subtree). The move still surfaces as
 * unseen — its create event postdates the migrated seen_at — matching the
 * "renamed = changed" convention.
 */
export function migrateSeenPaths(projectId, from, to) {
  querySync(
    `UPDATE OR REPLACE file_seen
     SET path = $3 || substr(path, length($2) + 1)
     WHERE project_id = $1
       AND (path = $2 OR substr(path, 1, length($2) + 1) = $2 || '/')`,
    [projectId, from, to],
  );
}
