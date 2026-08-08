import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Real in-memory SQLite — token/session lifecycles are SQL, so no DB mocks.
// Must be set before db.js is imported.
process.env.KUHN_SQLITE_PATH = ':memory:';

// Capture magic links instead of logging/sending them.
vi.mock('../mailer.js', () => ({ sendLoginLink: vi.fn(async () => {}) }));

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let exec; let querySync;
let sendLoginLink;
let session; let assertAuthConfig;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('../db.js'));
  ({ sendLoginLink } = await import('../mailer.js'));
  ({ session, assertAuthConfig } = await import('../session.js'));
  const { authRouter, meRouter } = await import('./auth.js');
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
  querySync('DELETE FROM auth_tokens');
  querySync('DELETE FROM auth_events');
  querySync('DELETE FROM invitations');
  querySync('DELETE FROM sessions');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (name, slug) VALUES ('Default', 'default')");
});

/** Run the full request-link → verify flow; returns the session cookie value. */
async function login(email = 'pi@lab.org') {
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

    // Invitation-only door (epic 011): a plain magic-link first login yields
    // a session but ZERO org memberships — invitations are the way in.
    const { rows } = querySync(
      "SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'pi@lab.org'",
    );
    expect(rows).toEqual([]);

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
  });

  it('a token is single-use: the second verify redirects to login=expired', async () => {
    const { url } = await login();
    const again = await fetch(url, { redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe(`${config.auth.appUrl}/?login=expired`);
    expect(querySync('SELECT COUNT(*) AS n FROM sessions').rows[0].n).toBe(1); // no second session
  });

  it('an expired token is rejected', async () => {
    await fetch(`${base}/api/auth/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pi@lab.org' }),
    });
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
