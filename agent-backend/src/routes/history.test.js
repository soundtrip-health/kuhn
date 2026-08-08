// Story 010-003: HTTP contract of the version-history routes, with the
// tenancy guard. Mock style like routes/render.test.js — the git mechanics
// are src/history.test.js's job; this suite asserts status mapping and the
// viewer/editor thresholds.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../history.js', () => ({
  commitNow: vi.fn(async () => 'commit-hash'),
  fileAtVersion: vi.fn(async () => Buffer.from('old content')),
  listHistory: vi.fn(async () => []),
}));
vi.mock('../storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, writeProjectFile: vi.fn(async () => ({ created: false })) };
});
vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));
// Tenancy guard dependencies (story 010-003).
vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(async (id) => (Number(id) === 1 ? { id: 1, org_id: 10 } : undefined)),
}));
vi.mock('../db/orgs.js', () => ({
  checkOrgAccess: vi.fn(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } })),
}));

import { commitNow, fileAtVersion, listHistory } from '../history.js';
import { checkOrgAccess } from '../db/orgs.js';
import { writeProjectFile, StorageError } from '../storage.js';
import historyRouter from './history.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for the session middleware: every request has a current user.
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(historyRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  vi.clearAllMocks();
});

const restore = (projectId, body) =>
  fetch(`${base}/api/projects/${projectId}/history/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('history routes (story 008-002)', () => {
  it('lists versions with a default limit', async () => {
    listHistory.mockResolvedValueOnce([{ hash: 'abc', label: 'Save' }]);
    const res = await fetch(`${base}/api/projects/1/history`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ history: [{ hash: 'abc', label: 'Save' }] });
    expect(listHistory).toHaveBeenCalledWith(1, null, 50);
  });

  it('serves content at a version, requiring path and ref', async () => {
    const res = await fetch(`${base}/api/projects/1/history/file?path=draft/main.md&ref=abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('old content');
    expect((await fetch(`${base}/api/projects/1/history/file?path=draft/main.md`)).status).toBe(400);
  });

  it('restore snapshots, writes back through storage, and commits a new version', async () => {
    const res = await restore(1, { path: 'draft/main.md', ref: 'abc123def' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: true, commit: 'commit-hash' });
    expect(writeProjectFile).toHaveBeenCalledWith(1, 'draft/main.md', expect.any(Buffer));
    expect(commitNow).toHaveBeenCalledTimes(2); // snapshot + restore commit
    expect((await restore(1, { path: 'draft/main.md' })).status).toBe(400);
  });

  it('maps storage errors and bad project ids', async () => {
    fileAtVersion.mockRejectedValueOnce(new StorageError('not_found', 'No such ref'));
    expect((await fetch(`${base}/api/projects/1/history/file?path=x.md&ref=nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/abc/history`)).status).toBe(400);
  });
});

describe('tenancy guard (story 010-003)', () => {
  it('404s unknown projects and non-members identically', async () => {
    expect((await fetch(`${base}/api/projects/99/history`)).status).toBe(404);
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
    const res = await fetch(`${base}/api/projects/1/history`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
  });

  it('viewers read history but cannot restore', async () => {
    checkOrgAccess.mockImplementation(async (_u, orgId, minRole = 'viewer') => (
      minRole === 'viewer'
        ? { ok: true, role: 'viewer', org: { id: orgId } }
        : { ok: false, reason: 'role', role: 'viewer' }
    ));
    expect((await fetch(`${base}/api/projects/1/history`)).status).toBe(200);
    const denied = await restore(1, { path: 'draft/main.md', ref: 'abc' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'requires editor role' });
    expect(writeProjectFile).not.toHaveBeenCalled();
    checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  });

  it('editors restore; a suspended org 403s reads too', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: true, role: 'editor', org: { id: 10 } });
    expect((await restore(1, { path: 'draft/main.md', ref: 'abc' })).status).toBe(200);
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'suspended', role: 'editor' });
    const res = await fetch(`${base}/api/projects/1/history`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization suspended' });
  });
});
