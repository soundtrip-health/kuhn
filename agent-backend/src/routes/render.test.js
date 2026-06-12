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

import { renderPdf, exportDocument } from '../render.js';
import { SandboxError } from '../sandbox.js';
import { StorageError } from '../storage.js';
import renderRouter from './render.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
