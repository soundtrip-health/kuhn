import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../render.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderPdf: vi.fn(),
    exportDocument: vi.fn(),
  };
});
// Tenancy guard dependencies (story 010-003) — every project resolves, and
// access defaults to full; role tests override checkOrgAccess per call.
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(async (id) => ({ id: Number(id), org_id: 10 })),
}));
vi.mock('../db/orgs.js', () => ({
  checkOrgAccess: vi.fn(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } })),
}));

import { checkOrgAccess } from '../db/orgs.js';
import { renderPdf, exportDocument } from '../render.js';
import { SandboxError } from '../sandbox.js';
import { StorageError } from '../storage.js';
import renderRouter from './render.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for the session middleware: every request has a current user.
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(renderRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  vi.clearAllMocks();
});

const postRender = (projectId, body) =>
  fetch(`${base}/api/projects/${projectId}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /render', () => {
  it('returns the PDF with a cache header', async () => {
    renderPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF-x'), cached: true });
    const res = await postRender(1, { path: 'draft/main.md' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('x-render-cache')).toBe('hit');
    expect(await res.text()).toBe('%PDF-x');
  });

  it('requires a path', async () => {
    const res = await postRender(1, {});
    expect(res.status).toBe(400);
  });

  it('maps compile failures to 422 with the stderr excerpt', async () => {
    renderPdf.mockRejectedValueOnce(new SandboxError('failed', 'Render failed (exit 1): error: unknown variable'));
    const res = await postRender(1, { path: 'draft/main.md' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('unknown variable');
  });

  it('maps timeouts to 504', async () => {
    renderPdf.mockRejectedValueOnce(new SandboxError('timeout', 'Sandbox timed out after 60000ms'));
    const res = await postRender(1, { path: 'draft/main.md' });
    expect(res.status).toBe(504);
  });

  it('maps missing sources to 404', async () => {
    renderPdf.mockRejectedValueOnce(new StorageError('not_found', 'No such file'));
    const res = await postRender(1, { path: 'draft/nope.md' });
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric project id', async () => {
    const res = await postRender('abc', { path: 'draft/main.md' });
    expect(res.status).toBe(400);
  });
});

describe('GET /export', () => {
  const exportUrl = (params) =>
    `${base}/api/projects/1/export?${new URLSearchParams(params)}`;

  it('returns the export as an attachment', async () => {
    exportDocument.mockResolvedValueOnce({
      output: Buffer.from('docx-bytes'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'main.docx',
    });
    const res = await fetch(exportUrl({ path: 'draft/main.md', format: 'docx' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="main.docx"');
    expect(await res.text()).toBe('docx-bytes');
  });

  it('rejects unknown formats', async () => {
    const res = await fetch(exportUrl({ path: 'draft/main.md', format: 'pdf' }));
    expect(res.status).toBe(400);
    expect(exportDocument).not.toHaveBeenCalled();
  });

  it('requires a path', async () => {
    const res = await fetch(exportUrl({ format: 'docx' }));
    expect(res.status).toBe(400);
  });
});

describe('tenancy guard (story 010-003)', () => {
  it('404s non-members without leaking, and never renders', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'not-member' });
    const res = await postRender(1, { path: 'draft/main.md' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it('render and export are viewer reads — a viewer passes', async () => {
    checkOrgAccess.mockResolvedValue({ ok: true, role: 'viewer', org: { id: 10 } });
    renderPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF-v'), cached: false });
    expect((await postRender(1, { path: 'draft/main.md' })).status).toBe(200);
    exportDocument.mockResolvedValueOnce({
      output: Buffer.from('x'), contentType: 'text/plain', filename: 'main.tex',
    });
    const exp = await fetch(`${base}/api/projects/1/export?${new URLSearchParams({ path: 'draft/main.md', format: 'tex' })}`);
    expect(exp.status).toBe(200);
    checkOrgAccess.mockResolvedValue({ ok: true, role: 'owner', org: { id: 10 } });
  });

  it('403s a suspended org with the guard body', async () => {
    checkOrgAccess.mockResolvedValueOnce({ ok: false, reason: 'suspended', role: 'owner' });
    const res = await postRender(1, { path: 'draft/main.md' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization suspended' });
    expect(renderPdf).not.toHaveBeenCalled();
  });
});
