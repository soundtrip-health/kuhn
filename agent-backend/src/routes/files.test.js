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
vi.mock('../db/file-activity.js', () => ({
  unseenPaths: vi.fn(() => new Set()),
  migrateSeenPaths: vi.fn(),
}));
vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));

import { config } from '../config.js';
import { unseenPaths, migrateSeenPaths } from '../db/file-activity.js';
import { publishProjectEvent } from '../project-events.js';
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
  // Stand-in for the session middleware, so attribution is observable (007-001).
  app.use((req, _res, next) => { req.user = { id: 9, email: 'dev@kuhn.local' }; next(); });
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

  it('moves and deletes files, publishing activity (story 005-002)', async () => {
    await fetch(url('/api/projects/1/file', { path: 'tmp.md' }), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    vi.clearAllMocks();
    const move = await fetch(url('/api/projects/1/files/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'tmp.md', to: 'archive/tmp.md' }),
    });
    expect(move.status).toBe(200);
    expect(migrateSeenPaths).toHaveBeenCalledWith(1, 'tmp.md', 'archive/tmp.md');
    expect(publishProjectEvent.mock.calls.map(([, e]) => [e.kind, e.path])).toEqual([
      ['delete', 'tmp.md'],
      ['create', 'archive/tmp.md'],
    ]);
    // User actions carry the session user's attribution (story 007-001).
    expect(publishProjectEvent.mock.calls.every(([, , opts]) => opts.userId === 9)).toBe(true);

    const del = await fetch(url('/api/projects/1/file', { path: 'archive/tmp.md' }), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(publishProjectEvent).toHaveBeenLastCalledWith(1, {
      type: 'file_change', path: 'archive/tmp.md', kind: 'delete',
    }, { userId: 9 });
    const gone = await fetch(url('/api/projects/1/file', { path: 'archive/tmp.md' }));
    expect(gone.status).toBe(404);
  });

  it('uploads files via multipart and publishes create events', async () => {
    const form = new FormData();
    form.append('path', 'figures');
    form.append('files', new Blob(['fig-bytes'], { type: 'image/png' }), 'fig1.png');
    const res = await fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const { files } = await res.json();
    expect(files).toEqual([expect.objectContaining({ path: 'figures/fig1.png', created: true })]);
    expect(publishProjectEvent).toHaveBeenCalledWith(1, {
      type: 'file_change', path: 'figures/fig1.png', kind: 'create',
    }, { userId: 9 });
  });

  it('tree nodes carry mtime and the current user\'s unseen flags (story 005-002)', async () => {
    unseenPaths.mockReturnValue(new Set(['draft/main.md']));
    const res = await fetch(url('/api/projects/1/files'));
    const { tree } = await res.json();
    const draft = tree.find((n) => n.name === 'draft');
    const main = draft.children.find((n) => n.name === 'main.md');
    expect(typeof main.mtime).toBe('string');
    expect(main.unseen).toBe(true);
    const others = draft.children.filter((n) => n !== main);
    expect(others.every((n) => n.unseen === undefined)).toBe(true);
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

  describe('upload size limits (story 026)', () => {
    let savedMax;
    beforeAll(() => {
      savedMax = config.storage.maxFileBytes;
      config.storage.maxFileBytes = 64;
    });
    afterAll(() => {
      config.storage.maxFileBytes = savedMax;
    });

    const oversize = () => new Blob(['y'.repeat(100)], { type: 'text/plain' });
    const valid = () => new Blob(['ok'], { type: 'text/plain' });

    it('maps an oversize multipart upload to 413 { error, code: too_large }', async () => {
      const form = new FormData();
      form.append('files', oversize(), 'big.txt');
      const res = await fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe('too_large');
      expect(body.error).toContain('64 bytes');
    });

    it('a mixed batch is all-or-nothing: valid files do not land either', async () => {
      const form = new FormData();
      form.append('files', valid(), 'small-026.txt');
      form.append('files', oversize(), 'big.txt');
      const res = await fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
      expect(res.status).toBe(413);
      const read = await fetch(url('/api/projects/1/file', { path: 'small-026.txt' }));
      expect(read.status).toBe(404);
    });

    it('maps too many files to 400 { code: too_many_files }', async () => {
      const form = new FormData();
      for (let i = 0; i < 21; i++) form.append('files', valid(), `f${i}.txt`);
      const res = await fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('too_many_files');
    });

    it('maps an oversize PUT raw body to 413 { code: too_large }', async () => {
      const res = await fetch(url('/api/projects/1/file', { path: 'big-raw.txt' }), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'z'.repeat(100),
      });
      expect(res.status).toBe(413);
      expect((await res.json()).code).toBe('too_large');
    });
  });

  it('maps unknown projects and files to 404, bad input to 400', async () => {
    expect((await fetch(url('/api/projects/99/files'))).status).toBe(404);
    expect((await fetch(url('/api/projects/1/file', { path: 'nope.md' }))).status).toBe(404);
    expect((await fetch(url('/api/projects/abc/files'))).status).toBe(400);
    expect((await fetch(url('/api/projects/1/file'))).status).toBe(400);
  });
});
