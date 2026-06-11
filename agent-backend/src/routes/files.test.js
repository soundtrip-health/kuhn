import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

vi.mock('../db.js', () => ({
  query: vi.fn(async (_sql, [id]) => ({
    rows: [1, 2].includes(Number(id)) ? [{ root_path: null }] : [],
  })),
}));

import { config } from '../config.js';
import filesRouter from './files.js';

let server;
let base;
let root;
let savedProjectsRoot;

beforeAll(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-files-'));
  config.agent.projectsRoot = root;
  await mkdir(join(root, '1', 'draft'), { recursive: true });
  await writeFile(join(root, '1', 'draft', 'main.md'), '# Hello\n');
  await mkdir(join(root, '2'), { recursive: true });
  await writeFile(join(root, '2', 'secret.md'), 'secret\n');

  const app = express();
  app.use(express.json());
  app.use(filesRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.agent.projectsRoot = savedProjectsRoot;
  await new Promise((ok) => server.close(ok));
  await rm(root, { recursive: true, force: true });
});

const url = (path, params = {}) => {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};

describe('file routes', () => {
  it('lists the project tree', async () => {
    const res = await fetch(url('/api/projects/1/files'));
    expect(res.status).toBe(200);
    const { tree } = await res.json();
    const draft = tree.find((n) => n.name === 'draft');
    expect(draft.children[0]).toMatchObject({ name: 'main.md', type: 'file' });
  });

  it('reads a file with a content type', async () => {
    const res = await fetch(url('/api/projects/1/file', { path: 'draft/main.md' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toBe('# Hello\n');
  });

  it('writes a file via PUT raw body', async () => {
    const res = await fetch(url('/api/projects/1/file', { path: 'notes/new.md' }), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'fresh content',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: true });

    const read = await fetch(url('/api/projects/1/file', { path: 'notes/new.md' }));
    expect(await read.text()).toBe('fresh content');
  });

  it('moves and deletes files', async () => {
    await fetch(url('/api/projects/1/file', { path: 'tmp.md' }), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    const move = await fetch(url('/api/projects/1/files/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'tmp.md', to: 'archive/tmp.md' }),
    });
    expect(move.status).toBe(200);

    const del = await fetch(url('/api/projects/1/file', { path: 'archive/tmp.md' }), { method: 'DELETE' });
    expect(del.status).toBe(200);
    const gone = await fetch(url('/api/projects/1/file', { path: 'archive/tmp.md' }));
    expect(gone.status).toBe(404);
  });

  it('uploads files via multipart', async () => {
    const form = new FormData();
    form.append('path', 'figures');
    form.append('files', new Blob(['fig-bytes'], { type: 'image/png' }), 'fig1.png');
    const res = await fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const { files } = await res.json();
    expect(files).toEqual([expect.objectContaining({ path: 'figures/fig1.png', created: true })]);
  });

  it('maps containment violations to 403', async () => {
    for (const path of ['../2/secret.md', '/etc/hosts', 'draft/../../outside.txt']) {
      const res = await fetch(url('/api/projects/1/file', { path }));
      expect(res.status, path).toBe(403);
    }
    const put = await fetch(url('/api/projects/1/file', { path: '../2/injected.md' }), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    expect(put.status).toBe(403);
  });

  it('maps unknown projects and files to 404, bad input to 400', async () => {
    expect((await fetch(url('/api/projects/99/files'))).status).toBe(404);
    expect((await fetch(url('/api/projects/1/file', { path: 'nope.md' }))).status).toBe(404);
    expect((await fetch(url('/api/projects/abc/files'))).status).toBe(400);
    expect((await fetch(url('/api/projects/1/file'))).status).toBe(400);
  });
});
