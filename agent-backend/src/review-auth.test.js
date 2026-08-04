// Epic 013 story 001: guest identity — cookie parsing, principal resolution
// and the reviewerSession middleware. Real in-memory SQLite behind the store;
// the middleware is driven with hand-rolled req/res (no HTTP server needed).
//
// Deliberately runs with config.auth.mode left at its 'dev' default: the guest
// path is credential-scoped in EVERY mode — these tests would be vacuous if a
// dev bypass existed.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';
process.env.KUHN_SESSION_SECRET = 'test-secret';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync; let exec;
let links; let auth;
let PROJECT_ID;
const USER = 7;

beforeAll(async () => {
  ({ exec, querySync } = await import('./db.js'));
  exec(readFileSync(resolve(__dirname, 'db', 'schema.sql'), 'utf-8'));
  links = await import('./db/review-links.js');
  auth = await import('./review-auth.js');
});

beforeEach(() => {
  querySync('DELETE FROM review_sessions');
  querySync('DELETE FROM review_links');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'dev@kuhn.local', 'Dev User')", [USER]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
});

/** Mint + claim, returning {link, cookieHeader}. */
function claimedLink(over = {}) {
  const { token, link } = links.createReviewLink({
    projectId: PROJECT_ID, path: 'draft/main.md', mode: 'comment', createdBy: USER, ...over,
  });
  const { cookieValue } = links.claimReviewLink(token, 'Jane');
  return { link, cookieValue, cookieHeader: `${auth.REVIEW_COOKIE}=${encodeURIComponent(cookieValue)}` };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('readReviewCookie', () => {
  it('reads from an Express-shaped req or a raw Cookie header', () => {
    const { cookieValue, cookieHeader } = claimedLink();
    expect(auth.readReviewCookie({ headers: { cookie: cookieHeader } })).toBe(cookieValue);
    expect(auth.readReviewCookie(cookieHeader)).toBe(cookieValue);
    expect(auth.readReviewCookie(`other=1; ${cookieHeader}; more=2`)).toBe(cookieValue);
  });

  it('ignores kuhn_session and tolerates missing/empty input', () => {
    expect(auth.readReviewCookie('kuhn_session=abc.def')).toBeNull();
    expect(auth.readReviewCookie(undefined)).toBeNull();
    expect(auth.readReviewCookie({ headers: {} })).toBeNull();
    expect(auth.readReviewCookie('')).toBeNull();
  });
});

describe('reviewerPrincipal', () => {
  it('resolves a live claimed session to the principal shape', () => {
    const { link, cookieHeader } = claimedLink({ mode: 'edit' });
    const principal = auth.reviewerPrincipal(cookieHeader);
    expect(principal).toEqual({
      kind: 'reviewer',
      linkId: link.id,
      projectId: PROJECT_ID,
      path: 'draft/main.md',
      mode: 'edit',
      name: 'Jane',
      expiresAt: expect.any(String),
    });
    // req.user is never part of this path — the principal is the whole grant.
    expect(principal).not.toHaveProperty('user');
  });

  it('bumps last_active_at as a side effect', () => {
    const { link, cookieHeader } = claimedLink();
    auth.reviewerPrincipal(cookieHeader);
    const { rows } = querySync('SELECT last_active_at FROM review_links WHERE id = $1', [link.id]);
    expect(rows[0].last_active_at).toBeTruthy();
  });

  it('is null without a cookie, and a member kuhn_session cookie grants nothing', () => {
    expect(auth.reviewerPrincipal({ headers: {} })).toBeNull();
    // Even a validly signed value under the MEMBER cookie name is invisible.
    const { cookieValue } = claimedLink();
    expect(auth.reviewerPrincipal(`kuhn_session=${encodeURIComponent(cookieValue)}`)).toBeNull();
  });

  it('dies with the link: revocation and expiry take effect on the next call', () => {
    const revoked = claimedLink();
    expect(auth.reviewerPrincipal(revoked.cookieHeader)).toBeTruthy();
    links.revokeReviewLink(PROJECT_ID, revoked.link.id, { revokedBy: USER });
    expect(auth.reviewerPrincipal(revoked.cookieHeader)).toBeNull();

    const expired = claimedLink();
    querySync(
      "UPDATE review_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = $1",
      [expired.link.id],
    );
    expect(auth.reviewerPrincipal(expired.cookieHeader)).toBeNull();
  });
});

describe('reviewerSession middleware', () => {
  it('sets req.reviewer and calls next() for a live session', () => {
    const { link, cookieHeader } = claimedLink();
    const req = { headers: { cookie: cookieHeader } };
    const res = fakeRes();
    let nexted = false;
    auth.reviewerSession(req, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(req.reviewer).toMatchObject({ kind: 'reviewer', linkId: link.id });
    expect(req.user).toBeUndefined();
    expect(res.statusCode).toBeNull();
  });

  it('401s with a stable code when the cookie is missing, forged, or dead', () => {
    for (const cookie of [undefined, 'kuhn_review_session=forged.value']) {
      const res = fakeRes();
      let nexted = false;
      auth.reviewerSession({ headers: { cookie } }, res, () => { nexted = true; });
      expect(nexted).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('review_session_invalid');
    }

    const { link, cookieHeader } = claimedLink();
    links.revokeReviewLink(PROJECT_ID, link.id, {});
    const res = fakeRes();
    auth.reviewerSession({ headers: { cookie: cookieHeader } }, res, () => {
      throw new Error('must not reach the handler after revocation');
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('review_session_invalid');
  });
});
