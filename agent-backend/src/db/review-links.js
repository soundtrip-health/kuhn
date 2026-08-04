// Epic 013 story 001: external-review magic links, scoped to ONE document.
// All review DB access lives here. Two secrets, same discipline as db/auth.js:
// the URL token (minted here, shown once) and the per-claim session token
// (signed into the kuhn_review_session cookie) — the DB stores only sha256
// hashes of both, so a leaked database cannot mint reviewer access.
//
// Everything is synchronous (querySync) so callers can run inside
// better-sqlite3 transaction() bodies and the WS upgrade path needs no await.

import { createHash, randomBytes } from 'node:crypto';

import { querySync, transaction } from '../db.js';
import { StorageError } from '../storage.js';
import { signSessionToken, verifySessionCookie } from './auth.js';
import { recordFileEvent } from './file-activity.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const REVIEW_MODES = ['view', 'comment', 'edit'];

const HOUR_MS = 60 * 60 * 1000;
const MIN_TTL_MS = HOUR_MS;
const MAX_TTL_MS = 90 * 24 * HOUR_MS;
const DEFAULT_TTL_MS = 7 * 24 * HOUR_MS;

/** last_active_at write throttle — at most one UPDATE per link per minute. */
const TOUCH_STALENESS_MS = 60 * 1000;

/** Reviewer edit-mode feed cadence: one file_events row per link per window. */
const EDIT_EVENT_WINDOW_MS = 5 * 60 * 1000;

// The proven subtree idiom (db/move-paths.js:48) with $2 = path prefix.
const SUBTREE = "(path = $2 OR substr(path, 1, length($2) + 1) = $2 || '/')";

/** Public link shape — camelCased, and NEVER includes token_hash. */
function shapeLink(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    mode: row.mode,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    reviewerName: row.reviewer_name ?? null,
    claimedAt: row.claimed_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    expiresAt: row.expires_at,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** State precedence: revoked > expired > claimed > unclaimed. */
function linkState(row) {
  if (row.revoked_at != null) return 'revoked';
  if (row.expires_at < new Date().toISOString()) return 'expired';
  if (row.claimed_at != null) return 'claimed';
  return 'unclaimed';
}

/**
 * Trim, strip control characters, collapse inner whitespace, cap at 80 chars.
 * @returns {string|null} null when nothing displayable remains
 */
export function sanitizeReviewerName(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Mint a review link for one document. The raw token appears ONLY in the
 * return value — the row stores its hash.
 * @param {{projectId: number, path: string, mode: 'view'|'comment'|'edit',
 *          createdBy: number, ttlMs?: number}} opts
 * @returns {{token: string, link: object}}
 * @throws {StorageError} 'invalid_mode' for an unknown mode
 */
export function createReviewLink({ projectId, path, mode, createdBy, ttlMs = DEFAULT_TTL_MS }) {
  if (!REVIEW_MODES.includes(mode)) {
    throw new StorageError('invalid_mode', `mode must be one of ${REVIEW_MODES.join(', ')}`);
  }
  const ttl = Math.min(Math.max(Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const { rows } = querySync(
    `INSERT INTO review_links (project_id, path, mode, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [projectId, path, mode, sha256(token), createdBy, expiresAt],
  );
  return { token, link: shapeLink(rows[0]) };
}

/**
 * Resolve a raw URL token to its link + lifecycle state (drives the claim
 * page's name prompt vs the three refusal screens).
 * @returns {{state: 'unclaimed'|'claimed'|'expired'|'revoked', link: object}|null}
 *   null for a token that matches no link at all
 */
export function lookupReviewLink(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const { rows } = querySync(
    'SELECT * FROM review_links WHERE token_hash = $1', [sha256(token)],
  );
  if (rows.length === 0) return null;
  return { state: linkState(rows[0]), link: shapeLink(rows[0]) };
}

/**
 * Atomic single-claim: flip claimed_at and open the reviewer session in ONE
 * transaction (a crash between the two must not burn the link). Mirrors
 * consumeAuthToken's guarded-UPDATE atomicity for the claim itself.
 * @returns {{ok: true, cookieValue: string, expiresAt: string, link: object} |
 *           {ok: false, reason: 'not_found'|'claimed'|'expired'|'revoked'}}
 * @throws {StorageError} 'invalid_name' when no displayable name remains
 */
export function claimReviewLink(token, name) {
  const reviewerName = sanitizeReviewerName(name);
  if (reviewerName == null) {
    throw new StorageError('invalid_name', 'a display name is required');
  }
  return transaction(() => {
    const { rows } = querySync(
      `UPDATE review_links
       SET claimed_at = ${NOW}, reviewer_name = $2, updated_at = ${NOW}
       WHERE token_hash = $1 AND claimed_at IS NULL AND revoked_at IS NULL
         AND expires_at >= ${NOW}
       RETURNING *`,
      [sha256(token), reviewerName],
    );
    if (rows.length === 0) {
      const existing = querySync(
        'SELECT * FROM review_links WHERE token_hash = $1', [sha256(token)],
      ).rows[0];
      return { ok: false, reason: existing ? linkState(existing) : 'not_found' };
    }
    const link = rows[0];
    // Opportunistic prune, then the session: expires exactly when the link does.
    querySync(`DELETE FROM review_sessions WHERE expires_at < ${NOW}`);
    const sessionToken = randomBytes(32).toString('base64url');
    querySync(
      'INSERT INTO review_sessions (token_hash, link_id, expires_at) VALUES ($1, $2, $3)',
      [sha256(sessionToken), link.id, link.expires_at],
    );
    return {
      ok: true,
      cookieValue: signSessionToken(sessionToken),
      expiresAt: link.expires_at,
      link: shapeLink(link),
    };
  });
}

/**
 * Resolve a kuhn_review_session cookie value to its live link. Runs per
 * request with no cache — revocation takes effect on the very next request.
 * @returns {{linkId: number, projectId: number, path: string,
 *            mode: 'view'|'comment'|'edit', name: string|null,
 *            expiresAt: string}|null}
 */
export function getReviewerSession(cookieValue) {
  const token = verifySessionCookie(cookieValue);
  if (!token) return null;
  const { rows } = querySync(
    `SELECT l.id, l.project_id, l.path, l.mode, l.reviewer_name, l.expires_at
     FROM review_sessions s
     JOIN review_links l ON l.id = s.link_id
     WHERE s.token_hash = $1 AND s.expires_at >= ${NOW}
       AND l.revoked_at IS NULL AND l.claimed_at IS NOT NULL AND l.expires_at >= ${NOW}`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    linkId: row.id,
    projectId: row.project_id,
    path: row.path,
    mode: row.mode,
    name: row.reviewer_name,
    expiresAt: row.expires_at,
  };
}

/**
 * Revoke one link (project-scoped) and kill its sessions. Idempotent: an
 * already-revoked link returns its row untouched; sessions are re-purged.
 * The caller closes any live sockets (yjs-websocket's reviewer registry).
 * @returns {object|null} the shaped link, or null when it isn't this project's
 */
export function revokeReviewLink(projectId, linkId, { revokedBy = null } = {}) {
  return transaction(() => {
    const { rows } = querySync(
      `UPDATE review_links
       SET revoked_at = ${NOW}, revoked_by = $3, updated_at = ${NOW}
       WHERE project_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING *`,
      [projectId, linkId, revokedBy],
    );
    let row = rows[0];
    if (!row) {
      row = querySync(
        'SELECT * FROM review_links WHERE project_id = $1 AND id = $2',
        [projectId, linkId],
      ).rows[0];
      if (!row) return null;
    }
    querySync('DELETE FROM review_sessions WHERE link_id = $1', [linkId]);
    return shapeLink(row);
  });
}

/**
 * Revoke every live link at or under a path (file delete takes its links and
 * a folder delete its subtree's). Returns the revoked link ids so the caller
 * can close their sockets.
 * @returns {number[]}
 */
export function revokeLinksUnder(projectId, path) {
  return transaction(() => {
    const { rows } = querySync(
      `UPDATE review_links
       SET revoked_at = ${NOW}, updated_at = ${NOW}
       WHERE project_id = $1 AND revoked_at IS NULL AND ${SUBTREE}
       RETURNING id`,
      [projectId, path],
    );
    const ids = rows.map((r) => r.id);
    for (const id of ids) {
      querySync('DELETE FROM review_sessions WHERE link_id = $1', [id]);
    }
    return ids;
  });
}

/**
 * Links for the active-links panel, newest first. Joins the minting user's
 * display name; never returns hashes.
 * @returns {object[]}
 */
export function listReviewLinks(projectId, { path = null, includeRevoked = false } = {}) {
  const { rows } = querySync(
    `SELECT l.*, u.display_name AS created_by_name
     FROM review_links l
     LEFT JOIN users u ON u.id = l.created_by
     WHERE l.project_id = $1
       AND ($2 IS NULL OR l.path = $2)
       AND ($3 OR l.revoked_at IS NULL)
     ORDER BY l.created_at DESC, l.id DESC`,
    [projectId, path, includeRevoked ? 1 : 0],
  );
  return rows.map(shapeLink);
}

/** Bump last_active_at, at most once per TOUCH_STALENESS_MS per link. */
export function touchLinkActivity(linkId) {
  querySync(
    `UPDATE review_links SET last_active_at = ${NOW}
     WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < $2)`,
    [linkId, new Date(Date.now() - TOUCH_STALENESS_MS).toISOString()],
  );
}

/**
 * Debounced feed truth for reviewer edits (013 decision: external writes ARE
 * surfaced, unlike silent member autosaves): at most one file_events row
 * (kind 'update', review_link_id) per link per 5-minute window.
 * @returns {boolean} true when a row was inserted
 */
export function recordReviewerEditEvent(projectId, linkId, path) {
  const windowStart = new Date(Date.now() - EDIT_EVENT_WINDOW_MS).toISOString();
  const { rows } = querySync(
    `SELECT 1 FROM file_events
     WHERE project_id = $1 AND review_link_id = $2 AND path = $3
       AND kind = 'update' AND created_at > $4
     LIMIT 1`,
    [projectId, linkId, path, windowStart],
  );
  if (rows.length > 0) return false;
  recordFileEvent(projectId, { path, kind: 'update', reviewLinkId: linkId });
  return true;
}
