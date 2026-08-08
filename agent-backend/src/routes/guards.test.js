// Story 010-003 / 011-001: the route-layer guard helpers, exercised through a
// stub express app against real in-memory SQLite. The 011-001 invariant test
// lives here: a super-admin without a membership gets a non-leaking 404 on
// org content — is_superadmin opens /api/admin only, never a tenant door.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let server; let base;
let PROJECT_ID;

const OWNER = 1;
const EDITOR = 2;
const VIEWER = 3;
const SUPERADMIN = 4; // flagged, NO membership anywhere
const ORG = 1;

// Mutable per-test identity, injected by the session stand-in below.
let sessionUser;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, '..', 'db', 'schema.sql'), 'utf-8'));
  const { requireProjectRole, requireOrgRole, requireSuperadmin } = await import('./guards.js');

  const app = express();
  app.use((req, _res, next) => { req.user = sessionUser; next(); });
  app.get('/projects/:id', async (req, res) => {
    const project = await requireProjectRole(req, res, req.params.id, 'viewer');
    if (!project) return;
    res.json({ id: project.id, orgId: project.org_id, role: req.orgRole });
  });
  app.post('/projects/:id/write', async (req, res) => {
    const project = await requireProjectRole(req, res, req.params.id, 'editor');
    if (!project) return;
    res.json({ role: req.orgRole });
  });
  app.get('/orgs/:id', async (req, res) => {
    const ctx = await requireOrgRole(req, res, req.params.id, 'viewer');
    if (!ctx) return;
    res.json(ctx);
  });
  app.post('/orgs/:id/admin', async (req, res) => {
    const ctx = await requireOrgRole(req, res, req.params.id, 'owner');
    if (!ctx) return;
    res.json({ role: ctx.role });
  });
  app.get('/admin', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    res.json({ ok: true });
  });
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  sessionUser = { id: OWNER, email: 'owner@lab.org', is_superadmin: 0 };
  querySync('DELETE FROM projects');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(`INSERT INTO users (id, email, is_superadmin) VALUES
    (${OWNER}, 'owner@lab.org', 0), (${EDITOR}, 'editor@lab.org', 0),
    (${VIEWER}, 'viewer@lab.org', 0), (${SUPERADMIN}, 'admin@platform.example', 1)`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (${OWNER}, ${ORG}, 'owner'), (${EDITOR}, ${ORG}, 'editor'), (${VIEWER}, ${ORG}, 'viewer')`);
  const { rows } = querySync(
    `INSERT INTO projects (org_id, name, project_type) VALUES (${ORG}, 'P', 'manuscript') RETURNING id`,
  );
  PROJECT_ID = rows[0].id;
});

const as = (id, flag = 0) => {
  sessionUser = { id, email: `u${id}@lab.org`, is_superadmin: flag };
};
const get = (path) => fetch(`${base}${path}`);
const post = (path) => fetch(`${base}${path}`, { method: 'POST' });

describe('requireProjectRole', () => {
  it('400s a non-numeric id', async () => {
    const res = await get('/projects/abc');
    expect(res.status).toBe(400);
  });

  it('404s a missing project and a non-member identically (no existence leak)', async () => {
    const missing = await get('/projects/999999');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'project not found' });
    as(99); // no users row needed — the membership query just finds nothing
    const denied = await get(`/projects/${PROJECT_ID}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: 'project not found' });
  });

  it('viewer reads (with req.orgRole stamped) but cannot write', async () => {
    as(VIEWER);
    const read = await get(`/projects/${PROJECT_ID}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ id: PROJECT_ID, orgId: ORG, role: 'viewer' });
    const write = await post(`/projects/${PROJECT_ID}/write`);
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'requires editor role' });
  });

  it('editor and owner clear the editor threshold', async () => {
    as(EDITOR);
    expect((await post(`/projects/${PROJECT_ID}/write`)).status).toBe(200);
    as(OWNER);
    const res = await post(`/projects/${PROJECT_ID}/write`);
    expect(await res.json()).toEqual({ role: 'owner' });
  });

  it('403s every member once the org is suspended', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    for (const id of [OWNER, EDITOR, VIEWER]) {
      as(id);
      const res = await get(`/projects/${PROJECT_ID}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'organization suspended' });
    }
  });
});

describe('requireOrgRole', () => {
  it('400s a non-numeric id, 404s unknown orgs and non-members alike', async () => {
    expect((await get('/orgs/abc')).status).toBe(400);
    expect((await get('/orgs/999')).status).toBe(404);
    as(99);
    const denied = await get(`/orgs/${ORG}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: 'organization not found' });
  });

  it('returns {orgId, role, org} and stamps the role', async () => {
    as(VIEWER);
    const res = await get(`/orgs/${ORG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgId: ORG, role: 'viewer',
      org: { id: ORG, name: 'Lab', slug: 'lab', status: 'active', settings: {} },
    });
  });

  it('owner threshold: editors 403 with the role error, owners pass', async () => {
    as(EDITOR);
    const denied = await post(`/orgs/${ORG}/admin`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'requires owner role' });
    as(OWNER);
    expect((await post(`/orgs/${ORG}/admin`)).status).toBe(200);
  });

  it('403s suspended orgs even for their owner', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    as(OWNER);
    const res = await post(`/orgs/${ORG}/admin`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization suspended' });
  });
});

describe('the 011-001 invariant: super-admin is not a tenant key', () => {
  it('a flagged non-member gets non-leaking 404s on org content', async () => {
    as(SUPERADMIN, 1);
    const project = await get(`/projects/${PROJECT_ID}`);
    expect(project.status).toBe(404);
    expect(await project.json()).toEqual({ error: 'project not found' });
    const org = await get(`/orgs/${ORG}`);
    expect(org.status).toBe(404);
    expect(await org.json()).toEqual({ error: 'organization not found' });
  });

  it('requireSuperadmin gates on the flag alone', async () => {
    as(SUPERADMIN, 1);
    expect((await get('/admin')).status).toBe(200);
    as(OWNER); // org owner, but not platform staff
    const denied = await get('/admin');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'super-admin required' });
  });
});
