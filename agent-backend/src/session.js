// Minimal identity/session resolution (story 005).
//
// Resolves a "current user" for every request so project/org queries can be
// tenant-scoped. This is deliberately NOT a full auth provider: the user is
// taken from the `x-kuhn-user` header (an email/handle) and falls back to the
// seeded dev user when absent — a dev login, not SSO. The user row is created
// on first sight (get-or-create) and, if they belong to no org yet, attached
// to the seeded default organization so they always have a workspace.
//
// Swapping in real auth later means replacing only this resolver: validate a
// token/cookie, map it to a `users` row, and attach `req.user`. Everything
// downstream already scopes on `req.user.id`.

import { query } from './db.js';

const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || 'dev@kuhn.local';
const DEFAULT_ORG_SLUG = 'default';

/**
 * Get-or-create a user by email, guaranteeing at least one org membership.
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
 * Express middleware: attach `req.user` from the `x-kuhn-user` header (or the
 * dev user). Fails closed with 503 if identity can't be resolved (e.g. DB down)
 * so handlers never run unscoped.
 */
export async function session(req, res, next) {
  try {
    const header = req.get('x-kuhn-user');
    req.user = await resolveUser(header);
    next();
  } catch (err) {
    res.status(503).json({ error: `identity unavailable: ${err.message}` });
  }
}
