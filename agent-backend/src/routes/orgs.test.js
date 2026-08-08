// Organization routes (story 005 listing; story 011-001 super-admin
// lifecycle). Real in-memory SQLite, org-admin.test.js style: the super-admin
// gate, the MB1 ownerEmail flow, suspension via the chokepoint, and the
// slug unique-violation are all SQL/guard behavior, so no DB mocks — only the
// mailer is mocked to capture invitation links.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

// Capture invitation links instead of logging/sending them.
vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const SA = 1;      // super-admin, deliberately NOT a member of any org
const OWNER = 2;   // owner of ORG
const EDITOR = 3;  // editor of ORG
const LONER = 4;   // existing user with no memberships

let config; let exec; let querySync;
let createOrg;
let sendInviteLink;
let createSession;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  ({ exec, querySync } = await import('../db.js'));
  ({ createOrg } = await import('../db/orgs.js'));
  ({ sendInviteLink } = await import('../mailer.js'));
  ({ createSession } = await import('../db/auth.js'));
  const { session } = await import('../session.js');
  const { default: orgsRouter } = await import('./orgs.js');
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const app = express();
  app.use(express.json());
  app.use(session);
  app.use(orgsRouter);
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
  for (const table of ['auth_events', 'invitations', 'sessions', 'projects', 'memberships', 'users', 'organizations']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(`INSERT INTO users (id, email, is_superadmin) VALUES (${SA}, 'root@kuhn.dev', 1)`);
  querySync(`INSERT INTO users (id, email) VALUES (${OWNER}, 'owner@lab.org')`);
  querySync(`INSERT INTO users (id, email) VALUES (${EDITOR}, 'editor@lab.org')`);
  querySync(`INSERT INTO users (id, email) VALUES (${LONER}, 'loner@other.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${OWNER}, ${ORG}, 'owner')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${EDITOR}, ${ORG}, 'editor')`);
  querySync(`INSERT INTO projects (id, name, project_type, org_id) VALUES (10, 'Doc', 'manuscript', ${ORG})`);
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

const eventTypes = () =>
  querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type);

const membershipsOf = (orgId) =>
  querySync('SELECT user_id, role FROM memberships WHERE org_id = $1 ORDER BY user_id', [orgId]).rows;

describe('super-admin gate (011-001)', () => {
  const routes = [
    ['POST', '/api/orgs', { name: 'New Lab' }],
    ['GET', '/api/admin/orgs'],
    ['PATCH', `/api/admin/orgs/${ORG}`, { name: 'X' }],
  ];

  it('403s every lifecycle route for a non-super-admin, even an org owner', async () => {
    const cookie = await cookieFor(OWNER);
    for (const [method, path, body] of routes) {
      const res = await api(method, path, { cookie, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'super-admin required' });
    }
    expect(membershipsOf(ORG)).toHaveLength(2); // nothing changed
  });
});

describe('GET /api/orgs', () => {
  it("returns the session user's orgs with role and status", async () => {
    const res = await api('GET', '/api/orgs', { cookie: await cookieFor(OWNER) });
    expect(res.status).toBe(200);
    const { orgs } = await res.json();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ id: ORG, name: 'Lab', slug: 'lab', role: 'owner', status: 'active' });
  });

  it('still lists a suspended org, carrying its status', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    const { orgs } = await (await api('GET', '/api/orgs', { cookie: await cookieFor(EDITOR) })).json();
    expect(orgs[0]).toMatchObject({ id: ORG, status: 'suspended' });
  });
});

describe('POST /api/orgs (super-admin create, MB1 ownerEmail flow)', () => {
  it('400s without a name, with a symbols-only name, and with a bad ownerEmail', async () => {
    const cookie = await cookieFor(SA);
    expect((await api('POST', '/api/orgs', { cookie, body: {} })).status).toBe(400);
    expect((await api('POST', '/api/orgs', { cookie, body: { name: '!!!' } })).status).toBe(400);
    expect((await api('POST', '/api/orgs', { cookie, body: { name: 'Ok', ownerEmail: 'not-an-email' } })).status).toBe(400);
  });

  it('creates an ownerless org without ownerEmail — and the creator stays a stranger to it', async () => {
    const cookie = await cookieFor(SA);
    const res = await api('POST', '/api/orgs', { cookie, body: { name: 'Okafor Lab' } });
    expect(res.status).toBe(201);
    const { org, member } = await res.json();
    expect(member).toBe(false);
    expect(org).toMatchObject({ name: 'Okafor Lab', slug: 'okafor-lab', status: 'active' });
    expect(org.role).toBeUndefined();
    expect(membershipsOf(org.id)).toHaveLength(0);
    expect(eventTypes()).toEqual(['org.created']);
    // The 011-001 invariant, re-asserted at route level: the super-admin who
    // created the org gets a non-leaking 404 on its content.
    const projects = await api('GET', `/api/orgs/${org.id}/projects`, { cookie });
    expect(projects.status).toBe(404);
    expect(await projects.json()).toEqual({ error: 'organization not found' });
  });

  it('makes the caller owner when ownerEmail is their own account', async () => {
    const cookie = await cookieFor(SA);
    const res = await api('POST', '/api/orgs', {
      cookie,
      body: { name: 'Root Org', ownerEmail: 'Root@kuhn.dev' }, // case-insensitive
    });
    expect(res.status).toBe(201);
    const { org, member } = await res.json();
    expect(member).toBe(true);
    expect(org.role).toBe('owner');
    expect(membershipsOf(org.id)).toEqual([{ user_id: SA, role: 'owner' }]);
    expect(sendInviteLink).not.toHaveBeenCalled();
    // ...and now the caller CAN see the org's (empty) project list.
    expect((await api('GET', `/api/orgs/${org.id}/projects`, { cookie })).status).toBe(200);
  });

  it('grants an existing user direct owner membership without making the caller a member', async () => {
    const res = await api('POST', '/api/orgs', {
      cookie: await cookieFor(SA),
      body: { name: 'Loner Org', ownerEmail: 'loner@other.org' },
    });
    expect(res.status).toBe(201);
    const { org, member } = await res.json();
    expect(member).toBe(false);
    expect(org.role).toBeUndefined();
    expect(membershipsOf(org.id)).toEqual([{ user_id: LONER, role: 'owner' }]);
    expect(querySync('SELECT * FROM invitations').rows).toHaveLength(0);
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('issues an owner-role invitation (with mail) for an unknown ownerEmail', async () => {
    const res = await api('POST', '/api/orgs', {
      cookie: await cookieFor(SA),
      body: { name: 'Future Lab', ownerEmail: 'pi@future.edu' },
    });
    expect(res.status).toBe(201);
    const { org, member } = await res.json();
    expect(member).toBe(false);
    expect(membershipsOf(org.id)).toHaveLength(0);
    // No user row was conjured up — enrollment happens at redemption.
    expect(querySync("SELECT * FROM users WHERE email = 'pi@future.edu'").rows).toHaveLength(0);
    const invites = querySync('SELECT * FROM invitations').rows;
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      org_id: org.id, email: 'pi@future.edu', role: 'owner', invited_by: SA,
      accepted_at: null, revoked_at: null,
    });
    expect(sendInviteLink).toHaveBeenCalledTimes(1);
    const [to, url, opts] = sendInviteLink.mock.calls[0];
    expect(to).toBe('pi@future.edu');
    expect(url).toContain('/api/auth/verify?invite=');
    expect(opts).toEqual({ orgName: 'Future Lab' });
    expect(eventTypes()).toEqual(['org.created', 'invite.issued']);
  });

  it('respects an explicit slug', async () => {
    const res = await api('POST', '/api/orgs', {
      cookie: await cookieFor(SA),
      body: { name: 'Okafor Lab', slug: 'ok-lab' },
    });
    expect((await res.json()).org.slug).toBe('ok-lab');
  });

  it('409s on a duplicate slug', async () => {
    const res = await api('POST', '/api/orgs', {
      cookie: await cookieFor(SA),
      body: { name: 'Lab' }, // slugifies to 'lab', which exists
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('"lab" already exists');
    expect(eventTypes()).toEqual([]); // nothing recorded for a refused create
  });

  it('empirically: better-sqlite3 reports the slug conflict as SQLITE_CONSTRAINT_UNIQUE', async () => {
    // The route's isUniqueViolation must match the REAL error, not the
    // retired node-postgres '23505'.
    await expect(createOrg({ name: 'Lab 2', slug: 'lab' })).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
  });
});

describe('GET /api/admin/orgs', () => {
  it('lists every org with member counts, including orgs the super-admin cannot enter', async () => {
    querySync("INSERT INTO organizations (id, name, slug, status) VALUES (2, 'Empty', 'empty', 'suspended')");
    const res = await api('GET', '/api/admin/orgs', { cookie: await cookieFor(SA) });
    expect(res.status).toBe(200);
    const { orgs } = await res.json();
    expect(orgs).toHaveLength(2);
    expect(orgs[0]).toMatchObject({ id: ORG, name: 'Lab', slug: 'lab', status: 'active', member_count: 2 });
    expect(orgs[0].created_at).toBeTruthy();
    expect(orgs[1]).toMatchObject({ id: 2, status: 'suspended', member_count: 0 });
  });
});

describe('PATCH /api/admin/orgs/:id', () => {
  it('404s for an unknown org and 400s bad patches', async () => {
    const cookie = await cookieFor(SA);
    expect((await api('PATCH', '/api/admin/orgs/999', { cookie, body: { name: 'X' } })).status).toBe(404);
    expect((await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie, body: {} })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie, body: { name: '  ' } })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie, body: { status: 'frozen' } })).status).toBe(400);
    expect(eventTypes()).toEqual([]);
  });

  it('renames an org and records org.renamed', async () => {
    const res = await api('PATCH', `/api/admin/orgs/${ORG}`, {
      cookie: await cookieFor(SA),
      body: { name: 'Renamed Lab' },
    });
    expect(res.status).toBe(200);
    const { org } = await res.json();
    expect(org).toMatchObject({ id: ORG, name: 'Renamed Lab', slug: 'lab', status: 'active', member_count: 2 });
    expect(eventTypes()).toEqual(['org.renamed']);
    // Members see the new name.
    const { orgs } = await (await api('GET', '/api/orgs', { cookie: await cookieFor(OWNER) })).json();
    expect(orgs[0].name).toBe('Renamed Lab');
  });

  it('suspends: members 403 via the chokepoint, GET /api/orgs still lists the org', async () => {
    const sa = await cookieFor(SA);
    const ownerCookie = await cookieFor(OWNER);
    const res = await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie: sa, body: { status: 'suspended' } });
    expect((await res.json()).org.status).toBe('suspended');
    expect(eventTypes()).toEqual(['org.suspended']);

    const refused = await api('GET', `/api/orgs/${ORG}/projects`, { cookie: ownerCookie });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'organization suspended' });
    const { orgs } = await (await api('GET', '/api/orgs', { cookie: ownerCookie })).json();
    expect(orgs[0]).toMatchObject({ id: ORG, status: 'suspended' });
  });

  it('unsuspends: access restored, org.unsuspended recorded; admin PATCH ignores suspension', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    const sa = await cookieFor(SA);
    // Rename-while-suspended works — /api/admin ignores org status by design.
    expect((await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie: sa, body: { name: 'Still Here' } })).status).toBe(200);

    const res = await api('PATCH', `/api/admin/orgs/${ORG}`, { cookie: sa, body: { status: 'active' } });
    expect((await res.json()).org.status).toBe('active');
    expect(eventTypes()).toEqual(['org.renamed', 'org.unsuspended']);

    const restored = await api('GET', `/api/orgs/${ORG}/projects`, { cookie: await cookieFor(EDITOR) });
    expect(restored.status).toBe(200);
    expect((await restored.json()).projects).toHaveLength(1);
  });

  it('does not re-record an event when the status is unchanged', async () => {
    const res = await api('PATCH', `/api/admin/orgs/${ORG}`, {
      cookie: await cookieFor(SA),
      body: { status: 'active' },
    });
    expect(res.status).toBe(200);
    expect(eventTypes()).toEqual([]);
  });
});

describe('GET /api/orgs/:id/projects', () => {
  it('lists projects for a member', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/projects`, { cookie: await cookieFor(EDITOR) });
    expect(res.status).toBe(200);
    expect((await res.json()).projects).toHaveLength(1);
  });

  it('404s non-leakingly for a non-member', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/projects`, { cookie: await cookieFor(LONER) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'organization not found' });
  });
});
