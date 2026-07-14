// Story 007-002: magic-link login. Two routers because they sit on opposite
// sides of the session middleware:
//   authRouter — request-link / verify / logout, mounted BEFORE session()
//     (a user logging in has no identity yet; logout must work on an expired
//     session too).
//   meRouter — /api/auth/me, mounted AFTER session() so it can report the
//     resolved user; the webapp uses it for the "signed in as" line and to
//     decide whether to offer Sign out (dev mode has nothing to sign out of).

import { Router } from 'express';
import { config } from '../config.js';
import {
  createAuthToken,
  consumeAuthToken,
  createSession,
  deleteSession,
} from '../db/auth.js';
import { sendLoginLink } from '../mailer.js';
import { resolveUser, SESSION_COOKIE, readSessionCookie } from '../session.js';

const authRouter = Router();

// Deliberately loose: enough to catch typos, not an RFC gauntlet.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.auth.appUrl.startsWith('https://'),
  path: '/',
});

/**
 * POST /api/auth/request-link — body { email }
 * Mint a single-use token and deliver the verify link. Always 200 for a
 * well-formed email: whether an account exists is not disclosed (and cannot
 * be — verify get-or-creates the user).
 */
authRouter.post('/api/auth/request-link', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'a valid email is required' });
    return;
  }
  const { token } = await createAuthToken(email);
  const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?token=${encodeURIComponent(token)}`;
  await sendLoginLink(email, verifyUrl);
  res.json({ ok: true });
});

/**
 * GET /api/auth/verify?token=…
 * Redeem the token: get-or-create the user (first login lands in the default
 * org — resolveUser's existing behavior), open a session, set the signed
 * cookie, and redirect into the app. Invalid/expired/reused tokens redirect
 * with ?login=expired so the webapp can say "request a new link".
 */
authRouter.get('/api/auth/verify', async (req, res) => {
  const email = typeof req.query.token === 'string'
    ? await consumeAuthToken(req.query.token)
    : null;
  if (!email) {
    res.redirect(`${config.auth.appUrl}/?login=expired`);
    return;
  }
  const user = await resolveUser(email);
  const { cookieValue, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE, cookieValue, {
    ...cookieOptions(),
    expires: new Date(expiresAt),
  });
  res.redirect(`${config.auth.appUrl}/`);
});

/** POST /api/auth/logout — revoke the session and clear the cookie. */
authRouter.post('/api/auth/logout', async (req, res) => {
  const cookieValue = readSessionCookie(req);
  if (cookieValue) await deleteSession(cookieValue);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});

const meRouter = Router();

/** GET /api/auth/me — the session user and the active auth mode. */
meRouter.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user, mode: config.auth.mode === 'dev' ? 'dev' : 'magic-link' });
});

export { authRouter, meRouter };
