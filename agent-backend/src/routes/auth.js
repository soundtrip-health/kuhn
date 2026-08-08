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
import { acceptInvitedMembership, redeemInvitation } from '../db/invitations.js';
import { recordAuthEvent } from '../db/auth-events.js';
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

// Refusal → login-overlay copy key (webapp/src/login.ts renders these).
const INVITE_REFUSALS = {
  missing: 'invite-invalid',
  revoked: 'invite-revoked',
  used: 'invite-used',
  expired: 'invite-expired',
  suspended: 'invite-suspended',
};

/**
 * The invitation door (story 011-002): redeem the invite token, get-or-create
 * the invited user, grant the membership at the invited role, and sign them
 * in. An already-a-member redemption burns the invitation but never touches
 * the existing role — the overlay explains and offers a normal sign-in.
 * Refusals redirect with ?login=invite-<reason>; a suspended-org refusal
 * happens BEFORE the accept, so that token stays valid for after an unsuspend.
 */
async function redeemInviteAndSignIn(req, res) {
  const result = redeemInvitation(req.query.invite);
  if (!result.ok) {
    res.redirect(`${config.auth.appUrl}/?login=${INVITE_REFUSALS[result.reason]}`);
    return;
  }
  const { invitation, org } = result;
  const user = await resolveUser(invitation.email);
  const joined = acceptInvitedMembership(user.id, invitation);
  recordAuthEvent({
    type: 'invite.redeemed',
    actorUserId: user.id,
    orgId: org.id,
    email: invitation.email,
    meta: { invitationId: invitation.id, role: invitation.role, alreadyMember: !joined },
  });
  if (!joined) {
    res.redirect(`${config.auth.appUrl}/?login=invite-already-member`);
    return;
  }
  const { cookieValue, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE, cookieValue, {
    ...cookieOptions(),
    expires: new Date(expiresAt),
  });
  res.redirect(`${config.auth.appUrl}/`);
}

/**
 * GET /api/auth/verify?token=… | ?invite=…
 * The one verify door. ?token= redeems a magic-link token: get-or-create the
 * user, open a session, set the signed cookie, and redirect into the app
 * (membership-less outside dev — invitations are the door into an org).
 * Invalid/expired/reused tokens redirect with ?login=expired so the webapp
 * can say "request a new link". ?invite= redeems an invitation instead.
 */
authRouter.get('/api/auth/verify', async (req, res) => {
  if (typeof req.query.invite === 'string') {
    await redeemInviteAndSignIn(req, res);
    return;
  }
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
