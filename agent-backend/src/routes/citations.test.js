// Story 010-003: HTTP contract of the citation routes, with the tenancy
// guard. Mock style like routes/render.test.js — PubMed mechanics live in
// src/citations.test.js; this suite asserts validation, status mapping, and
// the viewer/editor thresholds.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../citations.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    searchCitations: vi.fn(async () => []),
    upsertCitation: vi.fn(async () => ({
      key: 'smith2024', created: true, bibtex: '@article{smith2024}', path: 'draft/references.bib',
    })),
  };
});
vi.mock('../db/references.js', () => ({ listProjectReferences: vi.fn(async () => []) }));
// Tenancy guard dependencies (story 010-003).
vi.mock('../db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(async (id) => (Number(id) === 1 ? { id: 1, org_id: 10 } : undefined)),
}));
vi.mock('../db/orgs.js', () => ({
  checkOrgAccess: vi.fn(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } })),
}));

import { searchCitations, upsertCitation, UpstreamError } from '../citations.js';
import { listProjectReferences } from '../db/references.js';
import { checkOrgAccess } from '../db/orgs.js';
import citationsRouter from './citations.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for the session middleware: every request has a current user.
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(citationsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(() => new Promise((ok) => server.close(ok)));

beforeEach(() => {
  vi.clearAllMocks();
});

const addCitation = (projectId, body) =>
  fetch(`${base}/api/projects/${projectId}/citations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('citation routes (story 016)', () => {
  it('searches with a clamped max and requires q', async () => {
    searchCitations.mockResolvedValueOnce([{ pmid: '1', title: 'T' }]);
    const res = await fetch(`${base}/api/projects/1/citations/search?q=glp1&max=100`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [{ pmid: '1', title: 'T' }] });
    expect(searchCitations).toHaveBeenCalledWith('glp1', 25);
    expect((await fetch(`${base}/api/projects/1/citations/search?q=`)).status).toBe(400);
  });

  it('upserts a citation (201 fresh, 200 existing) and requires pmid', async () => {
    const res = await addCitation(1, { pmid: '12345' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: 'smith2024', created: true });
    upsertCitation.mockResolvedValueOnce({ key: 'smith2024', created: false, bibtex: 'x', path: 'p' });
    expect((await addCitation(1, { pmid: 12345 })).status).toBe(200);
    expect((await addCitation(1, {})).status).toBe(400);
  });

  it('lists stored references', async () => {
    listProjectReferences.mockResolvedValueOnce([{ key: 'a' }]);
    const res = await fetch(`${base}/api/projects/1/references`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ references: [{ key: 'a' }] });
  });

  it('maps upstream failures to 502', async () => {
    searchCitations.mockRejectedValueOnce(new UpstreamError('PubMed unavailable'));
    const res = await fetch(`${base}/api/projects/1/citations/search?q=x`);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('upstream');
  });
});

describe('tenancy guard (story 010-003)', () => {
  it('404s unknown projects and non-members identically, 400s bad ids', async () => {
    expect((await fetch(`${base}/api/projects/99/references`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/abc/references`)).status).toBe(400);
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
    const res = await fetch(`${base}/api/projects/1/citations/search?q=x`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
    expect(searchCitations).not.toHaveBeenCalled();
  });

  it('viewers search and list, but the bibliography upsert needs editor', async () => {
    checkOrgAccess.mockImplementation(async (_u, orgId, minRole = 'viewer') => (
      minRole === 'viewer'
        ? { ok: true, role: 'viewer', org: { id: orgId } }
        : { ok: false, reason: 'role', role: 'viewer' }
    ));
    expect((await fetch(`${base}/api/projects/1/citations/search?q=x`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects/1/references`)).status).toBe(200);
    const denied = await addCitation(1, { pmid: '12345' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'requires editor role' });
    expect(upsertCitation).not.toHaveBeenCalled();
    checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  });

  it('editors upsert; a suspended org 403s everything', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: true, role: 'editor', org: { id: 10 } });
    expect((await addCitation(1, { pmid: '12345' })).status).toBe(201);
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'suspended', role: 'editor' });
    const res = await fetch(`${base}/api/projects/1/references`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization suspended' });
  });
});
