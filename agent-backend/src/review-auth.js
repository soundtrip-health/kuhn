// Epic 013 story 001: guest (external reviewer) identity — deliberately a
// separate, narrower path than session.js. A reviewer holds ONLY the
// kuhn_review_session cookie, which session() cannot see (it reads only
// kuhn_session), so every member route stays structurally closed to guests;
// `req.user` is never set for reviewers. The guest path is credential-scoped
// and enforced identically in ALL auth modes — there is no dev-mode bypass
// here (otherwise dev-mode tests would be vacuous and the token-free check
// could not exercise refusals).

import { getReviewerSession, touchLinkActivity } from './db/review-links.js';

/** Reviewer session cookie name (single cookie by design — brief decision 2:
 *  claiming link B ends the browser's session for link A). */
export const REVIEW_COOKIE = 'kuhn_review_session';

/**
 * Extract the review cookie value from a request or a raw Cookie header (the
 * Yjs WS upgrade path has no Express req). Clone of session.js's
 * readSessionCookie, which is hardcoded to kuhn_session.
 * @param {{ headers?: { cookie?: string } } | string | undefined} reqOrHeader
 * @returns {string|null}
 */
export function readReviewCookie(reqOrHeader) {
  const header = typeof reqOrHeader === 'string' ? reqOrHeader : reqOrHeader?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REVIEW_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Resolve a request (or raw Cookie header) to a reviewer principal, or null.
 * Hits the DB every call — no cache, so revocation/expiry takes effect on the
 * next request — and throttled-bumps the link's last_active_at.
 * @returns {{kind: 'reviewer', linkId: number, projectId: number, path: string,
 *            mode: 'view'|'comment'|'edit', name: string|null,
 *            expiresAt: string}|null}
 */
export function reviewerPrincipal(reqOrHeader) {
  const cookieValue = readReviewCookie(reqOrHeader);
  if (!cookieValue) return null;
  const session = getReviewerSession(cookieValue);
  if (!session) return null;
  touchLinkActivity(session.linkId);
  return { kind: 'reviewer', ...session };
}

/**
 * Express middleware for /api/review/* session-bearing routes: sets
 * `req.reviewer` or 401s with a stable code the client keys its ended-session
 * overlay on. Never sets req.user.
 */
export function reviewerSession(req, res, next) {
  const principal = reviewerPrincipal(req);
  if (!principal) {
    res.status(401).json({ error: 'valid review session required', code: 'review_session_invalid' });
    return;
  }
  req.reviewer = principal;
  next();
}
