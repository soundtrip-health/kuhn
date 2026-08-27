// Identity/session resolution (story 005; real auth in story 007-002).
//
// Resolves a "current user" for every request so project/org queries can be
// tenant-scoped. Two modes (config.auth.mode):
//
//   'dev' (default)  — the `x-kuhn-user` header (an email/handle) or the
//     seeded dev user. No login, no cookies: local development and the
//     token-free check scripts keep working unchanged.
//   anything else    — the signed session cookie minted by the magic-link
//     flow (routes/auth.js) is the ONLY accepted identity; the header and
//     dev-user fallback are inert. No/invalid/expired cookie → 401.
//
// DEV MODE ONLY: the user row is created on first sight and an identity with
// no org yet is attached to the seeded default organization, so local
// development always has a workspace.
//
// Outside dev the install is INVITE-ONLY (STH-35): an invitation is the only
// thing that mints an account, and a magic link is only ever issued to an
// address that already has a membership (or the super-admin flag) —
// findEligibleUser below is that gate. Strangers go to the access-request
// queue instead of getting a session with zero memberships. Swapping in SSO
// later still means replacing only this resolver.

import { query } from './db.js';
import { config } from './config.js';
import { getSessionUser } from './db/auth.js';
import { getOrgSettings } from './db/org-settings.js';

const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || 'dev@kuhn.local';
const DEFAULT_ORG_SLUG = 'default';

/** Session cookie name (story 007-002). Shared with routes/auth.js. */
export const SESSION_COOKIE = 'kuhn_session';

/**
 * Extract the session cookie value from a request (or a raw Cookie header —
 * the Yjs WS upgrade path in story 007-003 has no Express req). Minimal
 * parser: we only ever need this one cookie, so no cookie-parser dependency.
 * @param {{ headers?: { cookie?: string } } | string | undefined} reqOrHeader
 * @returns {string|null}
 */
export function readSessionCookie(reqOrHeader) {
  const header = typeof reqOrHeader === 'string' ? reqOrHeader : reqOrHeader?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Fail fast at startup: outside dev mode a session secret is mandatory —
 * without one every cookie signature would be forgeable.
 */
export function assertAuthConfig() {
  if (config.auth.mode !== 'dev' && !config.auth.sessionSecret) {
    throw new Error(
      `KUHN_AUTH_MODE=${config.auth.mode} requires KUHN_SESSION_SECRET to be set`,
    );
  }
}

/**
 * Get-or-create a user by email. Callers are invitation redemption (the only
 * door that may mint an account — STH-35 removed self-registration, so
 * magic-link verify now looks users up instead) and per-request dev mode.
 * Deliberately does NOT grant any membership — dev mode's default-org
 * auto-join is ensureDefaultMembership, and outside dev an invitation is the
 * only door into an org (story 011-002).
 * @param {string} email
 * @returns {Promise<{id: number, email: string, display_name: string|null, is_superadmin: number}>}
 */
export async function resolveUser(email) {
  const normalized = (email || DEV_USER_EMAIL).trim().toLowerCase();

  const { rows } = await query(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, display_name, is_superadmin`,
    [normalized, normalized.split('@')[0]],
  );
  return rows[0];
}

/**
 * The sign-in gate (STH-35): resolve an email to a user who may be issued a
 * magic link. Self-registration is gone, so "existing account" is not enough
 * — the account must actually belong somewhere:
 *
 *   • at least one membership, or
 *   • the platform super-admin flag (who has no membership by design and must
 *     never be able to lock themselves out).
 *
 * Everyone else is a stranger to this install and goes to the access-request
 * queue. Checked at BOTH doors — link issuance and token verify — so a
 * membership revoked in between cannot be ridden in on an in-flight link.
 * @returns {Promise<object|null>} the users row, or null if not eligible
 */
export async function findEligibleUser(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.display_name, u.is_superadmin
     FROM users u
     WHERE u.email = $1
       AND (u.is_superadmin != 0
            OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id))`,
    [normalized],
  );
  return rows[0] ?? null;
}

/**
 * DEV-MODE workspace guarantee: attach a membership-less user to the seeded
 * default org so local development and the token-free check scripts keep
 * working with zero setup. Role honors the default org's default_member_role
 * setting (story 011-003), falling back to 'editor'.
 */
export async function ensureDefaultMembership(userId) {
  const { rows: memberRows } = await query(
    'SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  if (memberRows.length > 0) return;
  const { rows: orgRows } = await query(
    'SELECT id FROM organizations WHERE slug = $1',
    [DEFAULT_ORG_SLUG],
  );
  const org = orgRows[0];
  if (!org) return;
  const role = getOrgSettings(org.id)?.default_member_role ?? 'editor';
  await query(
    `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [userId, org.id, role],
  );
}

/**
 * Express middleware: attach `req.user` (see module doc for the two modes).
 * Fails closed — 401 without a valid session outside dev mode, 503 if
 * identity can't be resolved at all (e.g. DB down) — so handlers never run
 * unscoped.
 */
export async function session(req, res, next) {
  try {
    if (config.auth.mode === 'dev') {
      req.user = await resolveUser(req.get('x-kuhn-user'));
      await ensureDefaultMembership(req.user.id);
      next();
      return;
    }
    const user = await getSessionUser(readSessionCookie(req));
    if (!user) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(503).json({ error: `identity unavailable: ${err.message}` });
  }
}
