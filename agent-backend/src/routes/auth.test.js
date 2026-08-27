import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Real in-memory SQLite — token/session lifecycles are SQL, so no DB mocks.
// Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

// Capture outbound mail instead of logging/sending it. Which of the three
// gets called IS the assertion for STH-35 — the HTTP response is uniform.
vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
  sendAccessRequestReceived: vi.fn(async () => {}),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let exec; let querySync;
let sendLoginLink; let sendInviteLink; let sendAccessRequestReceived;
let session; let assertAuthConfig;
let resetLoginRateLimits;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('../db.js'));
  ({ sendLoginLink, sendInviteLink, sendAccessRequestReceived } = await import('../mailer.js'));
  ({ session, assertAuthConfig } = await import('../session.js'));
  const { authRouter, meRouter, resetLoginRateLimits: reset } = await import('./auth.js');
  resetLoginRateLimits = reset;
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const app = express();
  app.use(express.json());
  app.use(authRouter);
  app.use(session);
  app.use(meRouter);
  // Minimal protected route standing in for every tenant-scoped endpoint.
  app.get('/api/probe', (req, res) => res.json({ email: req.user.email }));
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = 'dev';
  config.auth.sessionSecret = '';
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  vi.clearAllMocks();
  // The limiter is process-wide, not per-test — without this every test after
  // the first few would 429 on a budget the previous ones spent.
  resetLoginRateLimits();
  querySync('DELETE FROM access_requests');
  querySync('DELETE FROM auth_tokens');
  querySync('DELETE FROM auth_events');
  querySync('DELETE FROM invitations');
  querySync('DELETE FROM sessions');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (name, slug) VALUES ('Default', 'default')");
});

/**
 * Make an address eligible for a magic link (STH-35): a user row plus a
 * membership. Every pre-existing login test assumed request-link would create
 * the account for it; invite-only means the test has to say who belongs.
 */
function seedMember(email, { superadmin = false } = {}) {
  const { rows } = querySync(
    'INSERT INTO users (email, display_name, is_superadmin) VALUES ($1, $2, $3) RETURNING id',
    [email, email.split('@')[0], superadmin ? 1 : 0],
  );
  if (!superadmin) {
    const orgId = querySync("SELECT id FROM organizations WHERE slug = 'default'").rows[0].id;
    querySync('INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)',
      [rows[0].id, orgId, 'editor']);
  }
  return rows[0].id;
}

const requestLink = (email, note) =>
  fetch(`${base}/api/auth/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note === undefined ? { email } : { email, note }),
  });

/** Run the full request-link → verify flow; returns the session cookie value. */
async function login(email = 'pi@lab.org', { seed = true } = {}) {
  if (seed) seedMember(email);
  const req = await fetch(`${base}/api/auth/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(req.status).toBe(200);
  const [, url] = sendLoginLink.mock.calls.at(-1);
  const verify = await fetch(url, { redirect: 'manual' });
  expect(verify.status).toBe(302);
  const setCookie = verify.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/kuhn_session=([^;]+)/);
  return { cookie: match ? decodeURIComponent(match[1]) : null, verify, url };
}

const probe = (cookie, headers = {}) =>
  fetch(`${base}/api/probe`, {
    headers: { ...(cookie ? { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` } : {}), ...headers },
  });

describe('magic-link login (story 007-002)', () => {
  it('request-link → verify sets a hardened cookie and signs the user in', async () => {
    const { cookie, verify } = await login('pi@lab.org');
    expect(cookie).toBeTruthy();
    const setCookie = verify.headers.get('set-cookie');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/`);

    const res = await probe(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'pi@lab.org' });

    // The link is a RE-entry door, never a registration: it signs in the
    // membership that already existed and grants nothing new (STH-35).
    const { rows } = querySync(
      "SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'pi@lab.org'",
    );
    expect(rows).toEqual([{ role: 'editor' }]);

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` },
    });
    expect(await me.json()).toMatchObject({ mode: 'magic-link', user: { email: 'pi@lab.org' } });
  });

  it('rejects a malformed email', async () => {
    const res = await fetch(`${base}/api/auth/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(sendLoginLink).not.toHaveBeenCalled();
    expect(sendAccessRequestReceived).not.toHaveBeenCalled();
    expect(querySync('SELECT COUNT(*) AS n FROM access_requests').rows[0].n).toBe(0);
  });

  it('a token is single-use: the second verify redirects to login=expired', async () => {
    const { url } = await login();
    const again = await fetch(url, { redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe(`${config.auth.appUrl}/?login=expired`);
    expect(querySync('SELECT COUNT(*) AS n FROM sessions').rows[0].n).toBe(1); // no second session
  });

  it('an expired token is rejected', async () => {
    seedMember('pi@lab.org');
    await requestLink('pi@lab.org');
    querySync("UPDATE auth_tokens SET expires_at = '2020-01-01T00:00:00.000Z'");
    const [, url] = sendLoginLink.mock.calls.at(-1);
    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/?login=expired`);
  });

  it('logout revokes the session server-side', async () => {
    const { cookie } = await login();
    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` },
    });
    expect(out.status).toBe(200);
    expect((await probe(cookie)).status).toBe(401); // replaying the old cookie fails
  });
});

describe('invitation redemption via the verify door (story 011-002)', () => {
  it('?invite= redeems: membership at the invited role plus a live session', async () => {
    const { createInvitation } = await import('../db/invitations.js');
    querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
    const { token } = createInvitation({
      orgId: 7, email: 'invitee@lab.org', role: 'viewer', ttlMs: 60_000,
    });

    const verify = await fetch(
      `${base}/api/auth/verify?invite=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
    );
    expect(verify.status).toBe(302);
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/`);
    const cookie = decodeURIComponent(
      (verify.headers.get('set-cookie') ?? '').match(/kuhn_session=([^;]+)/)[1],
    );

    const res = await probe(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'invitee@lab.org' });
    // Invitations grant EXACTLY the invited org+role — never the default org.
    expect(querySync(
      `SELECT m.org_id, m.role FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE u.email = 'invitee@lab.org'`,
    ).rows).toEqual([{ org_id: 7, role: 'viewer' }]);
    expect(querySync("SELECT type FROM auth_events").rows).toEqual([{ type: 'invite.redeemed' }]);
  });

  it('a dead invite token redirects with its reason and sets no cookie', async () => {
    const bad = await fetch(`${base}/api/auth/verify?invite=garbage`, { redirect: 'manual' });
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-invalid`);
    expect(bad.headers.get('set-cookie')).toBeNull();
  });
});

describe('invite-only sign-in door (STH-35)', () => {
  it('a stranger gets a queued request — no link, no token, no account', async () => {
    const res = await requestLink('stranger@evil.example', '  I heard about Kuhn  ');
    // The answer is identical to a member's: the login box must not disclose
    // who has an account here.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(sendLoginLink).not.toHaveBeenCalled();
    expect(sendInviteLink).not.toHaveBeenCalled();
    expect(sendAccessRequestReceived).toHaveBeenCalledWith('stranger@evil.example');

    expect(querySync('SELECT COUNT(*) AS n FROM users').rows[0].n).toBe(0);
    expect(querySync('SELECT COUNT(*) AS n FROM auth_tokens').rows[0].n).toBe(0);
    expect(querySync('SELECT email, note, status, request_count FROM access_requests').rows)
      .toEqual([{
        email: 'stranger@evil.example',
        note: 'I heard about Kuhn', // trimmed
        status: 'pending',
        request_count: 1,
      }]);
    expect(querySync('SELECT type FROM auth_events').rows).toEqual([{ type: 'access.requested' }]);
  });

  it('asking again bumps the existing row instead of queueing duplicates', async () => {
    await requestLink('stranger@evil.example');
    await requestLink('STRANGER@Evil.Example'); // same address, different case
    await requestLink('stranger@evil.example', 'let me in');

    const { rows } = querySync('SELECT email, note, request_count FROM access_requests');
    expect(rows).toEqual([
      { email: 'stranger@evil.example', note: 'let me in', request_count: 3 },
    ]);
    // Only the first ask is an event; the rest are noise.
    expect(querySync("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'access.requested'")
      .rows[0].n).toBe(1);
  });

  it('an account with no membership is a stranger, not a member', async () => {
    // The pre-STH-35 dead end: a user row from the old self-registration flow.
    querySync("INSERT INTO users (email, display_name) VALUES ('orphan@lab.org', 'orphan')");
    await requestLink('orphan@lab.org');

    expect(sendLoginLink).not.toHaveBeenCalled();
    expect(sendAccessRequestReceived).toHaveBeenCalledWith('orphan@lab.org');
    expect(querySync("SELECT status FROM access_requests WHERE email = 'orphan@lab.org'")
      .rows).toEqual([{ status: 'pending' }]);
  });

  it('a super-admin has no membership but still gets a link', async () => {
    seedMember('root@kuhn.local', { superadmin: true });
    await requestLink('root@kuhn.local');
    expect(sendLoginLink).toHaveBeenCalledTimes(1);
    expect(querySync('SELECT COUNT(*) AS n FROM access_requests').rows[0].n).toBe(0);
  });

  it('a pending invitation is re-issued rather than queued', async () => {
    const { createInvitation } = await import('../db/invitations.js');
    querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
    const { token: original } = createInvitation({
      orgId: 7, email: 'invitee@lab.org', role: 'viewer', ttlMs: 60_000,
    });

    await requestLink('invitee@lab.org');
    expect(sendLoginLink).not.toHaveBeenCalled();
    expect(sendAccessRequestReceived).not.toHaveBeenCalled();
    const [to, url, opts] = sendInviteLink.mock.calls.at(-1);
    expect(to).toBe('invitee@lab.org');
    expect(opts).toEqual({ orgName: 'Lab' });

    // The fresh link works and carries the ORIGINALLY invited role — a lost
    // invitation is recoverable without widening who may join, or at what level.
    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/`);
    expect(querySync(
      `SELECT m.org_id, m.role FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE u.email = 'invitee@lab.org'`,
    ).rows).toEqual([{ org_id: 7, role: 'viewer' }]);

    // ...and the superseded token is dead, so only one link is ever live.
    const stale = await fetch(
      `${base}/api/auth/verify?invite=${encodeURIComponent(original)}`,
      { redirect: 'manual' },
    );
    expect(stale.headers.get('location')).toBe(`${config.auth.appUrl}/?login=invite-revoked`);
  });

  it('an in-flight link dies when the last membership is revoked', async () => {
    seedMember('ex@lab.org');
    await requestLink('ex@lab.org');
    const [, url] = sendLoginLink.mock.calls.at(-1);

    // Removed from the org after the link was mailed but before it was clicked.
    querySync('DELETE FROM memberships');

    const verify = await fetch(url, { redirect: 'manual' });
    expect(verify.status).toBe(302);
    expect(verify.headers.get('location')).toBe(`${config.auth.appUrl}/?login=no-access`);
    expect(verify.headers.get('set-cookie')).toBeNull();
    expect(querySync('SELECT COUNT(*) AS n FROM sessions').rows[0].n).toBe(0);
  });

  it('redeeming an invitation settles that address\'s queued request', async () => {
    const { createInvitation } = await import('../db/invitations.js');
    querySync("INSERT INTO organizations (id, name, slug) VALUES (7, 'Lab', 'lab')");
    await requestLink('later@lab.org'); // asked first...
    const { token } = createInvitation({   // ...and an admin invited them after
      orgId: 7, email: 'later@lab.org', role: 'editor', ttlMs: 60_000,
    });
    await fetch(`${base}/api/auth/verify?invite=${encodeURIComponent(token)}`, { redirect: 'manual' });

    expect(querySync('SELECT status, decision_note FROM access_requests').rows)
      .toEqual([{ status: 'approved', decision_note: 'Invited directly' }]);
  });
});

describe('request-link rate limiting (STH-35)', () => {
  const LIMIT = 3;  // config.auth.requestLink.perEmailMax default
  const IP_LIMIT = 20;

  it('refuses a fourth attempt on one address with 429 + Retry-After', async () => {
    seedMember('pi@lab.org');
    for (let i = 0; i < LIMIT; i++) {
      expect((await requestLink('pi@lab.org')).status).toBe(200);
    }
    expect(sendLoginLink).toHaveBeenCalledTimes(LIMIT);

    const res = await requestLink('pi@lab.org');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).error).toMatch(/too many sign-in attempts/i);
    // The refusal is real: no fourth mail went out.
    expect(sendLoginLink).toHaveBeenCalledTimes(LIMIT);
  });

  it('spends case and whitespace variants from the same budget', async () => {
    seedMember('pi@lab.org');
    await requestLink('pi@lab.org');
    await requestLink('  PI@Lab.ORG  ');
    await requestLink('Pi@LAB.org');
    expect((await requestLink('pi@lab.org')).status).toBe(429);
    expect(sendLoginLink).toHaveBeenCalledTimes(LIMIT);
  });

  it('exhausting one address leaves every other address alone', async () => {
    seedMember('pi@lab.org');
    seedMember('other@lab.org');
    for (let i = 0; i <= LIMIT; i++) await requestLink('pi@lab.org');
    expect((await requestLink('other@lab.org')).status).toBe(200);
  });

  it('throttles a stranger and a member identically', async () => {
    // If the limit behaved differently for an unknown address, 429-vs-200
    // would be an account oracle — the exact thing the uniform 200 avoids.
    for (let i = 0; i < LIMIT; i++) await requestLink('stranger@evil.example');
    const stranger = await requestLink('stranger@evil.example');

    seedMember('pi@lab.org');
    for (let i = 0; i < LIMIT; i++) await requestLink('pi@lab.org');
    const member = await requestLink('pi@lab.org');

    expect(stranger.status).toBe(member.status);
    expect(await stranger.json()).toEqual(await member.json());
    // ...and the queue stopped growing when the budget ran out.
    expect(querySync('SELECT request_count FROM access_requests').rows)
      .toEqual([{ request_count: LIMIT }]);
  });

  it('audits a tripped limit once per window, not once per attempt', async () => {
    for (let i = 0; i < LIMIT + 3; i++) await requestLink('stranger@evil.example');
    expect(querySync("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'access.throttled'")
      .rows[0].n).toBe(1);
  });

  it('counts malformed attempts too, so 400s are not a free channel', async () => {
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await requestLink('not-an-email')).status).toBe(400);
    }
    // The IP budget is spent on garbage — the next well-formed attempt is
    // refused before it can reach the mailer.
    seedMember('pi@lab.org');
    const res = await requestLink('pi@lab.org');
    expect(res.status).toBe(429);
    expect(sendLoginLink).not.toHaveBeenCalled();
  });

  it('caps one client across many different addresses', async () => {
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await requestLink(`user${i}@lab.org`)).status).toBe(200);
    }
    // Per-email budgets are all untouched; it is the per-IP cap that bites.
    const res = await requestLink('yet-another@lab.org');
    expect(res.status).toBe(429);
    expect(querySync('SELECT COUNT(*) AS n FROM access_requests').rows[0].n).toBe(IP_LIMIT);
  });
});

describe('session middleware in real auth mode (story 007-002)', () => {
  it('401s without a cookie, and the x-kuhn-user dev fallback is inert', async () => {
    expect((await probe(null)).status).toBe(401);
    const spoofed = await probe(null, { 'x-kuhn-user': 'attacker@evil.example' });
    expect(spoofed.status).toBe(401);
    expect(querySync("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%evil%'").rows[0].n).toBe(0);
  });

  it('rejects tampered cookies: bad signature, bad token, or truncated value', async () => {
    const { cookie } = await login();
    const [token, sig] = [cookie.slice(0, cookie.lastIndexOf('.')), cookie.slice(cookie.lastIndexOf('.') + 1)];
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect((await probe(`${token}.${flip(sig)}`)).status).toBe(401);
    expect((await probe(`${flip(token)}.${sig}`)).status).toBe(401);
    expect((await probe(token)).status).toBe(401); // no signature at all
  });

  it('an expired session row is rejected even with a validly signed cookie', async () => {
    const { cookie } = await login();
    querySync("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
    expect((await probe(cookie)).status).toBe(401);
  });
});

describe('dev mode & startup guard (story 007-002)', () => {
  it('dev mode resolves the header user without any cookie', async () => {
    config.auth.mode = 'dev';
    try {
      const res = await probe(null, { 'x-kuhn-user': 'someone@lab.org' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: 'someone@lab.org' });
    } finally {
      config.auth.mode = 'magic-link';
    }
  });

  it('assertAuthConfig refuses non-dev mode without a secret', () => {
    const saved = config.auth.sessionSecret;
    try {
      config.auth.sessionSecret = '';
      expect(() => assertAuthConfig()).toThrow(/KUHN_SESSION_SECRET/);
      config.auth.mode = 'dev';
      expect(() => assertAuthConfig()).not.toThrow();
    } finally {
      config.auth.mode = 'magic-link';
      config.auth.sessionSecret = saved;
    }
  });
});
