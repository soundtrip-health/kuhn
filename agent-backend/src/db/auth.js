// Story 007-002: magic-link tokens and DB-backed sessions.
//
// Chosen session mechanism (the story's open decision): stateful sessions in
// SQLite rather than a stateless signed cookie — revocable on logout, no
// replay window after a secret rotation. The cookie the browser holds is
// `<token>.<hmac>`: an opaque 256-bit random token plus an HMAC-SHA256
// signature under KUHN_SESSION_SECRET. The signature rejects tampered or
// forged cookies without a DB roundtrip; the DB stores only sha256(token),
// so a leaked database cannot mint valid cookies.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sign = (token) =>
  createHmac('sha256', config.auth.sessionSecret).update(token).digest('base64url');

/** Serialize a session token into the signed cookie value. */
export function signSessionToken(token) {
  return `${token}.${sign(token)}`;
}

/**
 * Parse and authenticate a cookie value back to the raw session token.
 * @returns {string|null} null on missing/malformed/tampered input
 */
export function verifySessionCookie(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(token));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return token;
}

/**
 * Mint a single-use magic-link token for an email (story 007-002). Expired
 * tokens are pruned opportunistically here — no background job needed.
 * @returns {Promise<{token: string, expiresAt: string}>} token is the raw
 *   secret for the emailed link; only its hash is stored
 */
export async function createAuthToken(email) {
  await query(`DELETE FROM auth_tokens WHERE expires_at < ${NOW}`);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.tokenTtlMs).toISOString();
  await query(
    'INSERT INTO auth_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)',
    [sha256(token), email, expiresAt],
  );
  return { token, expiresAt };
}

/**
 * Redeem a magic-link token: single-use and unexpired, atomically marked used.
 * @returns {Promise<string|null>} the email it was issued for, or null
 */
export async function consumeAuthToken(token) {
  const { rows } = await query(
    `UPDATE auth_tokens SET used_at = ${NOW}
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at >= ${NOW}
     RETURNING email`,
    [sha256(token)],
  );
  return rows[0]?.email ?? null;
}

/**
 * Open a session for a user.
 * @returns {Promise<{cookieValue: string, expiresAt: string}>} cookieValue is
 *   the signed `<token>.<hmac>` for the Set-Cookie header
 */
export async function createSession(userId) {
  await query(`DELETE FROM sessions WHERE expires_at < ${NOW}`);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs).toISOString();
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [sha256(token), userId, expiresAt],
  );
  return { cookieValue: signSessionToken(token), expiresAt };
}

/**
 * Resolve a signed cookie value to its user (story 007-002): signature, then
 * unexpired session row, then the users row.
 * @returns {Promise<{id: number, email: string, display_name: string|null}|null>}
 */
export async function getSessionUser(cookieValue) {
  const token = verifySessionCookie(cookieValue);
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at >= ${NOW}`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

/** Revoke the session behind a cookie value (logout). Tolerates bad input. */
export async function deleteSession(cookieValue) {
  const token = verifySessionCookie(cookieValue);
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
