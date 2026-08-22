// Story 007-002: magic-link login, made INVITE-ONLY by STH-35. Two routers
// because they sit on opposite sides of the session middleware:
//   authRouter — request-link / verify / logout, mounted BEFORE session()
//     (a user logging in has no identity yet; logout must work on an expired
//     session too).
//   meRouter — /api/auth/me, mounted AFTER session() so it can report the
//     resolved user; the webapp uses it for the "signed in as" line and to
//     decide whether to offer Sign out (dev mode has nothing to sign out of).
//
// request-link is rate limited per email and per IP — it is unauthenticated,
// it sends mail, and it writes rows, which is the whole checklist.

import { Router } from 'express';
import { config } from '../config.js';
import {
  createAuthToken,
  consumeAuthToken,
  createSession,
  deleteSession,
} from '../db/auth.js';
import {
  acceptInvitedMembership,
  createInvitation,
  findLiveInvitationByEmail,
  redeemInvitation,
} from '../db/invitations.js';
import { recordAccessRequest, resolvePendingRequestsFor } from '../db/access-requests.js';
import { recordAuthEvent } from '../db/auth-events.js';
import { sendAccessRequestReceived, sendInviteLink, sendLoginLink } from '../mailer.js';
import {
  findEligibleUser,
  resolveUser,
  SESSION_COOKIE,
  readSessionCookie,
} from '../session.js';
import { createRateLimiter } from '../rate-limit.js';

const authRouter = Router();

// Deliberately loose: enough to catch typos, not an RFC gauntlet.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// request-link is the only unauthenticated endpoint that sends mail and
// writes rows, so it is the only one that needs a budget. See config.js for
// what each key buys; the per-email one is the load-bearing half.
const emailLimiter = createRateLimiter({
  limit: config.auth.requestLink.perEmailMax,
  windowMs: config.auth.requestLink.perEmailWindowMs,
});
const ipLimiter = createRateLimiter({
  limit: config.auth.requestLink.perIpMax,
  windowMs: config.auth.requestLink.perIpWindowMs,
});

/** Drop all rate-limit state. Test hook — nothing in the app calls this. */
export function resetLoginRateLimits() {
  emailLimiter.reset();
  ipLimiter.reset();
}

/**
 * Refuse an over-budget attempt with 429 + Retry-After. The refusal is keyed
 * on request VOLUME, never on whether the address exists, so it stays as
 * non-disclosing as the 200 it replaces. `tripped` limits the audit trail to
 * one row per offender per window.
 */
function refuseOverBudget(res, { retryAfterMs, tripped }, { kind, key }) {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  if (tripped) {
    recordAuthEvent({
      type: 'access.throttled',
      email: kind === 'email' ? key : null,
      meta: kind === 'email' ? { kind, retryAfter } : { kind, ip: key, retryAfter },
    });
  }
  const minutes = Math.ceil(retryAfter / 60);
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    retryAfter,
  });
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.auth.appUrl.startsWith('https://'),
  path: '/',
});

/**
 * The three ways a sign-in attempt can go (STH-35). Which one fired is
 * DELIBERATELY not visible in the HTTP response — the route always answers
 * 200 { ok: true }, so the login box cannot be used to enumerate who has an
 * account here. The difference shows up only in the recipient's mailbox.
 *
 *   'link'    — already a member (or the super-admin): the ordinary magic link.
 *   'invite'  — an admin already approved this address but the invitation was
 *               never redeemed: re-issue it. createInvitation revokes the
 *               prior pending token, so a lost invitation is self-service to
 *               recover without widening who may join.
 *   'request' — a stranger: queue an access request. No user row, no token,
 *               nothing that could reach an agent or the sandbox.
 */
async function routeSignIn(req, email, note) {
  const user = await findEligibleUser(email);
  if (user) {
    const { token } = await createAuthToken(email);
    const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?token=${encodeURIComponent(token)}`;
    await sendLoginLink(email, verifyUrl);
    return 'link';
  }

  const pending = findLiveInvitationByEmail(email);
  if (pending) {
    const { token } = createInvitation({
      orgId: pending.org_id,
      email,
      role: pending.role,
      invitedBy: pending.invited_by,
    });
    const inviteUrl = `${req.protocol}://${req.get('host')}/api/auth/verify?invite=${encodeURIComponent(token)}`;
    await sendInviteLink(email, inviteUrl, { orgName: pending.org_name });
    recordAuthEvent({
      type: 'invite.issued',
      orgId: pending.org_id,
      email,
      meta: { role: pending.role, reissued: true, reason: 'sign-in requested' },
    });
    return 'invite';
  }

  const { existing } = recordAccessRequest({ email, note });
  await sendAccessRequestReceived(email);
  if (!existing) recordAuthEvent({ type: 'access.requested', email });
  return 'request';
}

/**
 * POST /api/auth/request-link — body { email, note? }
 * The one front door. Always 200 for a well-formed email; see routeSignIn for
 * what actually happens behind that uniform answer. `note` is an optional
 * self-introduction kept only when the attempt becomes an access request.
 */
authRouter.post('/api/auth/request-link', async (req, res) => {
  // Per-IP first, so malformed bodies cost budget too — otherwise the 400
  // path is a free, unmetered way to hammer the endpoint.
  const byIp = ipLimiter.consume(req.ip ?? 'unknown');
  if (!byIp.ok) {
    refuseOverBudget(res, byIp, { kind: 'ip', key: req.ip ?? 'unknown' });
    return;
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'a valid email is required' });
    return;
  }
  // Keyed on the NORMALIZED address, so case and whitespace variants share
  // one budget rather than multiplying it.
  const byEmail = emailLimiter.consume(email);
  if (!byEmail.ok) {
    refuseOverBudget(res, byEmail, { kind: 'email', key: email });
    return;
  }
  await routeSignIn(req, email, req.body?.note);
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
  // Whatever brought them here, they are in now — stop showing an admin a
  // queued request for someone who already has access (STH-35).
  resolvePendingRequestsFor(invitation.email, { invitationId: invitation.id });
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
 * The one verify door. ?token= redeems a magic-link token: look the user up,
 * open a session, set the signed cookie, and redirect into the app. ?invite=
 * redeems an invitation instead — and remains the ONLY path here that may
 * create an account.
 *
 * Eligibility is re-checked here rather than trusted from issuance time
 * (STH-35): a link minted minutes ago must not still work after the last
 * membership behind it was removed. Invalid/expired/reused tokens redirect
 * with ?login=expired ("request a new link"); a token whose account no longer
 * qualifies redirects with ?login=no-access, which says something different
 * and must not be conflated.
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
  const user = await findEligibleUser(email);
  if (!user) {
    recordAuthEvent({ type: 'access.denied', email, meta: { at: 'verify' } });
    res.redirect(`${config.auth.appUrl}/?login=no-access`);
    return;
  }
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
