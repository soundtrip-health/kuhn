// Story 008-004: margin comments — anchored threads on document text. The
// store is deliberately position-dumb: a root row keeps the exact quoted text
// plus offset hints into the stored markdown, and consumers do the anchoring
// (the editor by quote search + decoration mapping; the add_comment tool by
// resolveQuote below, against disk content, before it ever inserts). Replies
// hang off the root via parent_id; resolve/reopen and anchor maintenance are
// root-only operations.

import { querySync } from '../db.js';
import { StorageError } from '../storage.js';

/** Occurrence cap when scanning for a quote — beyond this the quote is too
 *  generic to anchor meaningfully anyway. */
const MAX_OCCURRENCES = 50;

/**
 * Locate `quote` in `content`: exact occurrences first (nearest to `hint`
 * wins), then a whitespace-normalized scan so minor reflow doesn't orphan a
 * match. Returns { start, end, exact } in raw character offsets, or null.
 */
export function resolveQuote(content, quote, { hint = null } = {}) {
  if (!quote || !content) return null;
  const exact = allOccurrences(content, quote);
  if (exact.length > 0) {
    const start = nearest(exact, hint);
    return { start, end: start + quote.length, exact: true };
  }
  // Normalized fallback: collapse whitespace runs on both sides, keeping a
  // map from normalized offsets back to raw ones.
  const { norm, map } = normalizeWithMap(content);
  const normQuote = quote.replace(/\s+/g, ' ').trim();
  if (!normQuote) return null;
  const occ = allOccurrences(norm, normQuote);
  if (occ.length === 0) return null;
  const normStart = nearest(occ, hint);
  const start = map[normStart];
  const end = map[normStart + normQuote.length - 1] + 1;
  return { start, end, exact: false };
}

function allOccurrences(haystack, needle) {
  const out = [];
  let from = 0;
  while (out.length < MAX_OCCURRENCES) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

function nearest(occurrences, hint) {
  if (hint == null || occurrences.length === 1) return occurrences[0];
  let best = occurrences[0];
  for (const o of occurrences) {
    if (Math.abs(o - hint) < Math.abs(best - hint)) best = o;
  }
  return best;
}

/** Collapse whitespace runs to single spaces; map[i] = raw offset of norm[i]. */
function normalizeWithMap(content) {
  let norm = '';
  const map = [];
  let inSpace = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      inSpace = true;
      continue;
    }
    if (inSpace && norm.length > 0) {
      norm += ' ';
      map.push(i - 1);
    }
    inSpace = false;
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

function shape(row) {
  return {
    id: row.id,
    path: row.path,
    parentId: row.parent_id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    // Epic 013: external-reviewer attribution — the display name joins from
    // review_links.reviewer_name, mirroring user_name from users.display_name.
    reviewLinkId: row.review_link_id ?? null,
    reviewerName: row.reviewer_name ?? null,
    agent: row.agent_slug,
    jobId: row.job_id,
    body: row.body,
    anchor: row.parent_id == null
      ? { quote: row.anchor_quote, start: row.anchor_start, end: row.anchor_end }
      : null,
    orphaned: row.orphaned === 1,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name ?? null,
    resolvedByLinkId: row.resolved_by_link_id ?? null,
    resolvedByReviewerName: row.resolved_by_reviewer_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `
  SELECT c.*, u.display_name AS user_name, ru.display_name AS resolved_by_name,
         rl.reviewer_name AS reviewer_name, rrl.reviewer_name AS resolved_by_reviewer_name
  FROM comments c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN users ru ON ru.id = c.resolved_by
  LEFT JOIN review_links rl ON rl.id = c.review_link_id
  LEFT JOIN review_links rrl ON rrl.id = c.resolved_by_link_id`;

function getRow(projectId, id) {
  const { rows } = querySync(
    `${SELECT} WHERE c.project_id = $1 AND c.id = $2`, [projectId, id],
  );
  if (rows.length === 0) throw new StorageError('not_found', `No comment ${id} in project ${projectId}`);
  return rows[0];
}

/** Threads (roots with nested replies) for a project, optionally one path. */
export function listThreads(projectId, { path = null } = {}) {
  const { rows } = querySync(
    `${SELECT}
     WHERE c.project_id = $1 AND ($2 IS NULL OR c.path = $2)
     ORDER BY c.created_at, c.id`,
    [projectId, path],
  );
  const roots = new Map();
  const threads = [];
  for (const r of rows) {
    if (r.parent_id == null) {
      const t = { ...shape(r), replies: [] };
      roots.set(r.id, t);
      threads.push(t);
    }
  }
  for (const r of rows) {
    if (r.parent_id != null) roots.get(r.parent_id)?.replies.push(shape(r));
  }
  return threads;
}

/** Unresolved-thread count per path — the file-tree badge query. */
export function unresolvedCounts(projectId) {
  const { rows } = querySync(
    `SELECT path, COUNT(*) AS n FROM comments
     WHERE project_id = $1 AND parent_id IS NULL AND resolved_at IS NULL
     GROUP BY path`,
    [projectId],
  );
  return Object.fromEntries(rows.map((r) => [r.path, r.n]));
}

/** Create a thread root. Anchor fields are stored as given — REST callers
 *  send the editor selection; the agent tool resolves its quote first.
 *  Reviewer-authored rows (epic 013) pass reviewLinkId with userId null. */
export function createThread(projectId, {
  path, body, quote = null, start = null, end = null,
  userId = null, agentSlug = null, jobId = null, reviewLinkId = null,
}) {
  const { rows } = querySync(
    `INSERT INTO comments (project_id, path, user_id, agent_slug, job_id, review_link_id,
                           body, anchor_quote, anchor_start, anchor_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [projectId, path, userId, agentSlug, jobId, reviewLinkId, body, quote, start, end],
  );
  return { ...shape(getRow(projectId, rows[0].id)), replies: [] };
}

/** Append a reply to a thread root. */
export function addReply(projectId, rootId, {
  body, userId = null, agentSlug = null, jobId = null, reviewLinkId = null,
}) {
  const root = getRow(projectId, rootId);
  if (root.parent_id != null) {
    throw new StorageError('conflict', 'Replies attach to the thread root');
  }
  const { rows } = querySync(
    `INSERT INTO comments (project_id, path, parent_id, user_id, agent_slug, job_id,
                           review_link_id, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [projectId, root.path, rootId, userId, agentSlug, jobId, reviewLinkId, body],
  );
  return shape(getRow(projectId, rows[0].id));
}

/** Resolve or reopen a thread (root only). Member actors stamp resolved_by;
 *  reviewer actors (epic 013) stamp resolved_by_link_id instead. */
export function setResolved(projectId, id, resolved, { userId = null, reviewLinkId = null } = {}) {
  const row = getRow(projectId, id);
  if (row.parent_id != null) {
    throw new StorageError('conflict', 'Resolve applies to the thread root');
  }
  querySync(
    `UPDATE comments
     SET resolved_at = ${resolved ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : 'NULL'},
         resolved_by = $3,
         resolved_by_link_id = $4,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE project_id = $1 AND id = $2`,
    [projectId, id, resolved ? userId : null, resolved ? reviewLinkId : null],
  );
  return shape(getRow(projectId, id));
}

/**
 * Anchor maintenance from a live editor: updated quote/offsets after edits
 * inside the range, or orphaned=1 when the target text is gone (root only).
 * A re-found anchor clears the orphan flag.
 */
export function updateAnchor(projectId, id, { quote, start, end, orphaned } = {}) {
  const row = getRow(projectId, id);
  if (row.parent_id != null) {
    throw new StorageError('conflict', 'Anchors live on the thread root');
  }
  querySync(
    `UPDATE comments
     SET anchor_quote = COALESCE($3, anchor_quote),
         anchor_start = COALESCE($4, anchor_start),
         anchor_end   = COALESCE($5, anchor_end),
         orphaned     = COALESCE($6, orphaned),
         updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE project_id = $1 AND id = $2`,
    [projectId, id, quote ?? null, start ?? null, end ?? null,
     orphaned == null ? null : (orphaned ? 1 : 0)],
  );
  return shape(getRow(projectId, id));
}

/**
 * Delete a comment the acting identity authored (replies cascade off a root).
 * Two exact-match actor forms: `{userId}` matches member rows only (reviewer
 * rows have user_id NULL) and `{reviewLinkId}` (epic 013) matches that link's
 * rows only — neither can cross the wall. No identity at all is forbidden.
 */
export function deleteOwn(projectId, id, { userId = null, reviewLinkId = null } = {}) {
  const row = getRow(projectId, id);
  // Reviewers delete exactly their own link's comments — never a member's.
  // Members delete their own, plus any reviewer-authored comment: reviewers
  // are guests in the member's project, and once a link is revoked no other
  // identity could ever remove its content.
  const owns = reviewLinkId != null
    ? row.review_link_id === reviewLinkId
    : userId != null && (row.user_id === userId || (row.user_id === null && row.review_link_id != null));
  if (!owns) {
    throw new StorageError('forbidden', 'Only the comment author can delete it');
  }
  querySync(`DELETE FROM comments WHERE project_id = $1 AND id = $2`, [projectId, id]);
  return { path: row.path, rootId: row.parent_id ?? row.id };
}
