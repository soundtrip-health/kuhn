// Personal API tokens (issue #152, sciwriter interchange spec §2).
//
// A token is a bearer credential a signed-in user mints for scripts and
// external tools. It resolves to the SAME users row a session cookie would,
// so every guard, tenancy check and attribution downstream is unchanged —
// the token is an alternative way to present an identity, not a second
// identity model. Discipline mirrors db/auth.js: the DB holds only
// sha256(token); the raw value exists in the mint response and nowhere else.
//
// Deliberate limits: a token can never manage tokens (routes/auth.js refuses
// token-authenticated calls to /api/me/tokens), so a leaked token cannot mint
// itself an immortal replacement; expiry is capped at a year.

import { createHash, randomBytes } from 'node:crypto';
import { querySync } from '../db.js';

/** Raw tokens start with this so secret scanners and greps can find them. */
export const TOKEN_PREFIX = 'kuhn_';
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
const MAX_NAME_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
/** last_used_at is bumped at most this often per token — it is a display
 *  hint, not an audit log, and every API call would otherwise write a row. */
const TOUCH_INTERVAL_MS = 60 * 1000;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Validation failure — routes map to 400. */
export class ApiTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiTokenError';
  }
}

const publicRow = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

/**
 * Mint a token for a user. The returned `token` is the only copy of the raw
 * secret; `row` is the metadata the list endpoint would show.
 * @param {number} userId
 * @param {{name: string, expiresInDays?: number}} opts
 * @returns {{token: string, row: object}}
 */
export function createApiToken(userId, { name, expiresInDays } = {}) {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
    throw new ApiTokenError(`name is required (1-${MAX_NAME_LENGTH} characters)`);
  }
  const days = expiresInDays == null ? DEFAULT_TTL_DAYS : Number(expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_TTL_DAYS) {
    throw new ApiTokenError(`expires_in_days must be an integer from 1 to ${MAX_TTL_DAYS}`);
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
  const { rows } = querySync(
    `INSERT INTO api_tokens (user_id, name, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, cleanName, sha256(token), expiresAt],
  );
  return { token, row: publicRow(rows[0]) };
}

/** A user's unrevoked tokens, newest first (expired ones included — the UI
 *  labels them; they are harmless and the user may want to see what lapsed). */
export function listApiTokens(userId) {
  const { rows } = querySync(
    `SELECT * FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map(publicRow);
}

/**
 * Revoke one of the user's own tokens. Scoped to userId so a token id from
 * another account is simply "not found".
 * @returns {object|null} the revoked row, or null if no such live token
 */
export function revokeApiToken(userId, tokenId) {
  const { rows } = querySync(
    `UPDATE api_tokens SET revoked_at = ${NOW}
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING *`,
    [tokenId, userId],
  );
  return rows[0] ? publicRow(rows[0]) : null;
}

/**
 * Resolve a raw bearer token to its user: prefix, then a live (unrevoked,
 * unexpired) row, then the users row — the same shape getSessionUser returns
 * so session() can hand either to the guards. Bumps last_used_at (throttled).
 * @returns {{id: number, email: string, display_name: string|null, is_superadmin: number, tokenId: number}|null}
 */
export function resolveApiToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = querySync(
    `SELECT t.id AS token_id, t.last_used_at, u.id, u.email, u.display_name, u.is_superadmin
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at >= ${NOW}`,
    [sha256(rawToken)],
  );
  const row = rows[0];
  if (!row) return null;
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Date.now() - last > TOUCH_INTERVAL_MS) {
    querySync(`UPDATE api_tokens SET last_used_at = ${NOW} WHERE id = $1`, [row.token_id]);
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_superadmin: row.is_superadmin,
    tokenId: row.token_id,
  };
}
