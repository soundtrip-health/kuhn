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
// verify time) and, if they belong to no org yet, attached to the seeded
// default organization so they always have a workspace. Swapping in SSO
// later still means replacing only this resolver.

import { query } from './db.js';
import { config } from './config.js';
import { getSessionUser } from './db/auth.js';

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
 * Get-or-create a user by email, guaranteeing at least one org membership.
 * Called at magic-link verify time (007-002) and per-request in dev mode.
 * @param {string} email
 * @returns {Promise<{id: number, email: string, display_name: string|null}>}
 */
export async function resolveUser(email) {
  const normalized = (email || DEV_USER_EMAIL).trim().toLowerCase();

  const { rows } = await query(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, display_name`,
    [normalized, normalized.split('@')[0]],
  );
  const user = rows[0];

  // Ensure the user has a workspace: attach to the default org if they have no
  // membership yet (covers the dev user and any freshly resolved identity).
  const { rows: memberRows } = await query(
    'SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1',
    [user.id],
  );
  if (memberRows.length === 0) {
    await query(
      `INSERT INTO memberships (user_id, org_id, role)
       SELECT $1, o.id, 'member' FROM organizations o WHERE o.slug = $2
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [user.id, DEFAULT_ORG_SLUG],
    );
  }

  return user;
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
