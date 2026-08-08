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
// The user row is created on first sight (get-or-create at dev-request /
// verify time). DEV MODE ONLY: an identity with no org yet is attached to the
// seeded default organization so local development always has a workspace.
// Outside dev the door into an org is an invitation (story 011-002) — a plain
// magic-link sign-in yields a session with zero memberships. Swapping in SSO
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
 * Get-or-create a user by email. Called at magic-link verify time (007-002)
 * and per-request in dev mode. Deliberately does NOT grant any membership —
 * dev mode's default-org auto-join is ensureDefaultMembership, and outside
 * dev an invitation is the only door into an org (story 011-002).
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
