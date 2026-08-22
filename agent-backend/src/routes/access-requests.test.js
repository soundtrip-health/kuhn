// The super-admin access-request queue (STH-35). orgs.test.js style: real
// in-memory SQLite, only the mailer mocked. The interesting behavior is the
// gate (nobody but a super-admin sees the queue), the fact that approval goes
// out through the ordinary invitation machinery, and that a decided row
// cannot be decided twice.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
  sendAccessRequestReceived: vi.fn(async () => {}),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const SUSPENDED = 2;
const SA = 1;      // super-admin, deliberately NOT a member of any org
const OWNER = 2;   // owner of ORG — an org role is NOT a platform role

let config; let exec; let querySync;
let sendInviteLink;
let createSession;
let recordAccessRequest;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('../db.js'));
  ({ sendInviteLink } = await import('../mailer.js'));
  ({ createSession } = await import('../db/auth.js'));
  ({ recordAccessRequest } = await import('../db/access-requests.js'));
  const { session } = await import('../session.js');
  const { default: accessRequestsRouter } = await import('./access-requests.js');
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const app = express();
  app.use(express.json());
  app.use(session);
  app.use(accessRequestsRouter);
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
  for (const table of ['access_requests', 'auth_events', 'invitations', 'sessions', 'memberships', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(
    `INSERT INTO organizations (id, name, slug, status) VALUES (${SUSPENDED}, 'Dormant', 'dormant', 'suspended')`,
  );
  querySync(`INSERT INTO users (id, email, is_superadmin) VALUES (${SA}, 'root@kuhn.dev', 1)`);
  querySync(`INSERT INTO users (id, email) VALUES (${OWNER}, 'owner@lab.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${OWNER}, ${ORG}, 'owner')`);
});

async function cookieFor(userId) {
  const { cookieValue } = await createSession(userId);
  return cookieValue;
}

const api = (method, path, { cookie, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const queue = (email = 'newcomer@lab.org', note = 'PI at the Chen lab') =>
  recordAccessRequest({ email, note }).request;

const eventTypes = () =>
  querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type);

describe('the queue is super-admin only', () => {
  it('an org owner is not a platform admin', async () => {
    queue();
    const res = await api('GET', '/api/admin/access-requests', { cookie: await cookieFor(OWNER) });
    expect(res.status).toBe(403);
  });

  it('an anonymous caller gets 401 from the session middleware', async () => {
    expect((await api('GET', '/api/admin/access-requests')).status).toBe(401);
  });

  it('lists the queue, newest ask first, and filters by status', async () => {
    queue('a@lab.org');
    queue('b@lab.org');
    const cookie = await cookieFor(SA);

    const all = await api('GET', '/api/admin/access-requests', { cookie });
    expect(all.status).toBe(200);
    expect((await all.json()).requests.map((r) => r.email)).toEqual(['b@lab.org', 'a@lab.org']);

    const none = await api('GET', '/api/admin/access-requests?status=approved', { cookie });
    expect((await none.json()).requests).toEqual([]);

    const bad = await api('GET', '/api/admin/access-requests?status=nonsense', { cookie });
    expect(bad.status).toBe(400);
  });
});

describe('approving mints an ordinary invitation', () => {
  it('mails the invite, records it on the row, and logs both events', async () => {
    const request = queue();
    const res = await api('POST', `/api/admin/access-requests/${request.id}/approve`, {
      cookie: await cookieFor(SA),
      body: { orgId: ORG, role: 'editor', note: 'known collaborator' },
    });
    expect(res.status).toBe(200);

    const [to, url, opts] = sendInviteLink.mock.calls.at(-1);
    expect(to).toBe('newcomer@lab.org');
    expect(url).toContain('/api/auth/verify?invite=');
    expect(opts).toEqual({ orgName: 'Lab' });

    // The invitation is a normal one: right org, right role, hashed token.
    const [invitation] = querySync('SELECT org_id, email, role, invited_by FROM invitations').rows;
    expect(invitation).toEqual({
      org_id: ORG, email: 'newcomer@lab.org', role: 'editor', invited_by: SA,
    });

    const { request: settled } = await res.json();
    expect(settled).toMatchObject({
      status: 'approved',
      decided_by: SA,
      decided_by_email: 'root@kuhn.dev',
      decision_note: 'known collaborator',
    });
    expect(settled.invitation_id).toBeTruthy();
    expect(settled.decided_at).toBeTruthy();

    expect(eventTypes()).toEqual(['invite.issued', 'access.approved']);
  });

  it('refuses a role or org it cannot honor, without touching the row', async () => {
    const request = queue();
    const cookie = await cookieFor(SA);
    const cases = [
      [{ orgId: ORG, role: 'superuser' }, 400],       // not a role
      [{ orgId: 999, role: 'editor' }, 400],          // no such org
      [{ orgId: SUSPENDED, role: 'editor' }, 409],    // suspended org
    ];
    for (const [body, status] of cases) {
      const res = await api('POST', `/api/admin/access-requests/${request.id}/approve`, { cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    expect(sendInviteLink).not.toHaveBeenCalled();
    expect(querySync('SELECT status FROM access_requests').rows).toEqual([{ status: 'pending' }]);
  });

  it('refuses when the address is already a member of the target org', async () => {
    querySync("INSERT INTO users (id, email) VALUES (9, 'member@lab.org')");
    querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (9, ${ORG}, 'viewer')`);
    const request = queue('member@lab.org');

    const res = await api('POST', `/api/admin/access-requests/${request.id}/approve`, {
      cookie: await cookieFor(SA),
      body: { orgId: ORG, role: 'editor' },
    });
    expect(res.status).toBe(409);
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('a decided request cannot be decided again', async () => {
    const request = queue();
    const cookie = await cookieFor(SA);
    const body = { orgId: ORG, role: 'viewer' };
    expect((await api('POST', `/api/admin/access-requests/${request.id}/approve`, { cookie, body })).status).toBe(200);

    const again = await api('POST', `/api/admin/access-requests/${request.id}/approve`, { cookie, body });
    expect(again.status).toBe(409);
    const denyAfter = await api('POST', `/api/admin/access-requests/${request.id}/deny`, { cookie });
    expect(denyAfter.status).toBe(409);
    expect(querySync('SELECT COUNT(*) AS n FROM invitations').rows[0].n).toBe(1);
  });

  it('404s on an unknown id', async () => {
    const cookie = await cookieFor(SA);
    expect((await api('POST', '/api/admin/access-requests/4242/approve', {
      cookie, body: { orgId: ORG, role: 'editor' },
    })).status).toBe(404);
    expect((await api('POST', '/api/admin/access-requests/4242/deny', { cookie })).status).toBe(404);
  });
});

describe('denying', () => {
  it('settles the row silently — no invitation, no mail to the requester', async () => {
    const request = queue();
    const res = await api('POST', `/api/admin/access-requests/${request.id}/deny`, {
      cookie: await cookieFor(SA),
      body: { note: 'unknown to us' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({
      status: 'denied', decided_by: SA, decision_note: 'unknown to us', invitation_id: null,
    });
    expect(sendInviteLink).not.toHaveBeenCalled();
    expect(querySync('SELECT COUNT(*) AS n FROM invitations').rows[0].n).toBe(0);
    expect(eventTypes()).toEqual(['access.denied']);
  });

  it('a denial frees the address to ask again, keeping the old row as history', async () => {
    const first = queue();
    await api('POST', `/api/admin/access-requests/${first.id}/deny`, { cookie: await cookieFor(SA) });
    const second = queue();
    expect(second.id).not.toBe(first.id);
    expect(querySync('SELECT status FROM access_requests ORDER BY id').rows)
      .toEqual([{ status: 'denied' }, { status: 'pending' }]);
  });
});
