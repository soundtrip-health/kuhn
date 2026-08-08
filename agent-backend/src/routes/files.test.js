import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

vi.mock('../db.js', () => ({
  // Serves both storage.js (root_path) and guards.js → getProject (org_id).
  query: vi.fn(async (_sql, [id]) => ({
    rows: [1, 2].includes(Number(id))
      ? [{ id: Number(id), org_id: 10, root_path: null, config: '{}' }]
      : [],
  })),
}));
// The tenancy chokepoint (story 010-003): emulate the real rank check so each
// route's minRole is exercised; tests flip the granted role via grantRole().
vi.mock('../db/orgs.js', () => {
  const RANK = { viewer: 1, editor: 2, owner: 3 };
  const state = { role: 'owner', reason: null };
  return {
    __accessState: state,
    checkOrgAccess: vi.fn(async (_userId, orgId, minRole = 'viewer') => {
      if (state.reason) return { ok: false, reason: state.reason, role: state.role };
      if (RANK[state.role] < RANK[minRole]) return { ok: false, reason: 'role', role: state.role };
      return { ok: true, role: state.role, org: { id: orgId, status: 'active', settings: {} } };
    }),
  };
});
vi.mock('../db/file-activity.js', () => ({
  unseenPaths: vi.fn(() => new Set()),
  migrateSeenPaths: vi.fn(),
}));
vi.mock('../db/move-paths.js', () => ({ findPendingEditConflicts: vi.fn(() => []) }));
vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));

import { config } from '../config.js';
import * as orgsDb from '../db/orgs.js';
import { unseenPaths, migrateSeenPaths } from '../db/file-activity.js';
import { findPendingEditConflicts } from '../db/move-paths.js';
import { publishProjectEvent } from '../project-events.js';
import { StorageError } from '../storage.js';
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

  const move = (body) => fetch(url('/api/projects/1/files/move'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const put = (path, body) => fetch(url('/api/projects/1/file', { path }), {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body,
  });

  it('deletes files, publishing activity (story 005-002)', async () => {
    await put('doomed.md', 'x');
    vi.clearAllMocks();
    const del = await fetch(url('/api/projects/1/file', { path: 'doomed.md' }), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(publishProjectEvent).toHaveBeenLastCalledWith(1, {
      type: 'file_change', path: 'doomed.md', kind: 'delete',
    }, { userId: 9 });
    const gone = await fetch(url('/api/projects/1/file', { path: 'doomed.md' }));
    expect(gone.status).toBe(404);
  });

  describe('move (story 012-002)', () => {
    it('publishes one "moved" event, never a delete+create pair', async () => {
      await put('tmp.md', 'x');
      vi.clearAllMocks();
      const res = await move({ from: 'tmp.md', to: 'archive/tmp.md' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ from: 'tmp.md', to: 'archive/tmp.md', moved: true });
      expect(publishProjectEvent.mock.calls.map(([, e]) => [e.kind, e.path, e.meta?.from])).toEqual([
        ['moved', 'archive/tmp.md', 'tmp.md'],
      ]);
      // User actions carry the session user's attribution (story 007-001).
      expect(publishProjectEvent.mock.calls.every(([, , opts]) => opts.userId === 9)).toBe(true);
      // Seen state is re-keyed inside the hub's transaction now, not here.
      expect(migrateSeenPaths).not.toHaveBeenCalled();
    });

    it('leaves the old path 404ing and the new path serving the bytes (AC 5)', async () => {
      await put('ac5.md', 'bytes');
      expect((await move({ from: 'ac5.md', to: 'archive/ac5.md' })).status).toBe(200);
      expect((await fetch(url('/api/projects/1/file', { path: 'ac5.md' }))).status).toBe(404);
      const moved = await fetch(url('/api/projects/1/file', { path: 'archive/ac5.md' }));
      expect(moved.status).toBe(200);
      expect(await moved.text()).toBe('bytes');
    });

    it('publishes the canonical paths storage operated on, not the request body', async () => {
      await put('canon.md', 'x');
      vi.clearAllMocks();
      // './a' and 'a//b' rename fine on disk but would key the DB rewrite to a
      // path that matches no row.
      const res = await move({ from: './canon.md', to: 'archive//canon.md' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ from: 'canon.md', to: 'archive/canon.md' });
      expect(publishProjectEvent.mock.calls.map(([, e]) => [e.path, e.meta?.from])).toEqual([
        ['archive/canon.md', 'canon.md'],
      ]);
    });

    it('publishes ONE event for a moved folder, not one per descendant', async () => {
      await put('dir/a.md', 'a');
      await put('dir/sub/b.md', 'b');
      await put('directive.md', 'decoy');
      vi.clearAllMocks();
      const res = await move({ from: 'dir', to: 'archive/dir' });
      expect(res.status).toBe(200);
      expect(publishProjectEvent.mock.calls.map(([, e]) => [e.kind, e.path, e.meta?.from])).toEqual([
        ['moved', 'archive/dir', 'dir'],
      ]);
      expect((await fetch(url('/api/projects/1/file', { path: 'archive/dir/sub/b.md' }))).status).toBe(200);
      // The prefix look-alike is untouched.
      expect((await fetch(url('/api/projects/1/file', { path: 'directive.md' }))).status).toBe(200);
    });

    // AC 3 of story 012-001: the folder-into-own-descendant refusal is
    // server-side, not a UI courtesy. The storage guard lands as a plain 400.
    it('refuses to move a folder into its own descendant (400 invalid_path)', async () => {
      await put('nest-real/a.md', 'a');
      await put('nest-real/sub/b.md', 'b');
      vi.clearAllMocks();
      const res = await move({ from: 'nest-real', to: 'nest-real/sub/nest-real' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_path');
      // Nothing was announced and nothing moved: the descendants are still there
      // and no stray destination directory was left behind.
      expect(publishProjectEvent).not.toHaveBeenCalled();
      expect((await fetch(url('/api/projects/1/file', { path: 'nest-real/sub/b.md' }))).status).toBe(200);
      const sub = (await (await fetch(url('/api/projects/1/files', { path: 'nest-real/sub' }))).json()).tree;
      expect(sub.map((n) => n.name)).toEqual(['b.md']);
    });

    it('maps a degenerate move to 400, not 500', async () => {
      await put('self.md', 'x');
      for (const body of [
        { from: 'self.md', to: 'self.md' },
        { from: 'nest', to: 'nest/sub/nest' },
      ]) {
        const res = await move(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect((await res.json()).code).toBe('invalid_path');
      }
    });

    it('409s before the rename when a pending edit holds the destination', async () => {
      await put('clash.md', 'x');
      vi.clearAllMocks();
      findPendingEditConflicts.mockReturnValueOnce(['archive/clash.md']);
      const res = await move({ from: 'clash.md', to: 'archive/clash.md' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('conflict');
      // Pre-flight: the file never moved and nothing was announced.
      expect((await fetch(url('/api/projects/1/file', { path: 'clash.md' }))).status).toBe(200);
      expect(publishProjectEvent).not.toHaveBeenCalled();
    });

    it('renames back when the DB rewrite fails, so the two systems cannot disagree', async () => {
      await put('rollback.md', 'keep me');
      vi.clearAllMocks();
      publishProjectEvent.mockImplementationOnce(() => { throw new Error('applyMove exploded'); });
      const res = await move({ from: 'rollback.md', to: 'archive/rollback.md' });
      expect(res.status).toBe(500);
      const src = await fetch(url('/api/projects/1/file', { path: 'rollback.md' }));
      expect(src.status).toBe(200);
      expect(await src.text()).toBe('keep me');
      expect((await fetch(url('/api/projects/1/file', { path: 'archive/rollback.md' }))).status).toBe(404);
    });

    it('surfaces a StorageError from the rewrite with its own status, after the rollback', async () => {
      await put('conflict.md', 'x');
      vi.clearAllMocks();
      publishProjectEvent.mockImplementationOnce(() => {
        throw new StorageError('conflict', 'Pending edit at the destination');
      });
      const res = await move({ from: 'conflict.md', to: 'archive/conflict.md' });
      expect(res.status).toBe(409);
      expect((await fetch(url('/api/projects/1/file', { path: 'conflict.md' }))).status).toBe(200);
    });
  });

  describe('mkdir (story 012-001)', () => {
    const mkdirReq = (body) => fetch(url('/api/projects/1/files/mkdir'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    it('creates an empty folder and 201s with the canonical path', async () => {
      vi.clearAllMocks();
      // './x//y/' spellings must not become a second key for the folder the
      // tree reports as 'mk/deep'.
      const res = await mkdirReq({ path: './mk//deep/' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ path: 'mk/deep', created: true });

      const { tree } = await (await fetch(url('/api/projects/1/files'))).json();
      const mk = tree.find((n) => n.name === 'mk');
      expect(mk).toMatchObject({ type: 'dir' });
      expect(mk.children).toEqual([
        expect.objectContaining({ name: 'deep', type: 'dir', children: [] }),
      ]);
      // No event, no activity row: git cannot track an empty directory and
      // file_change is file-shaped. Collaborators see it on their next refresh.
      expect(publishProjectEvent).not.toHaveBeenCalled();
    });

    it('is idempotent: a repeat is 200 { created: false }', async () => {
      expect((await mkdirReq({ path: 'mk/again' })).status).toBe(201);
      const res = await mkdirReq({ path: 'mk/again' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ path: 'mk/again', created: false });
    });

    it('400s on a missing or non-string path', async () => {
      for (const body of [{}, { path: '' }, { path: 42 }, { path: null }, { path: ['a'] }]) {
        const res = await mkdirReq(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(typeof (await res.json()).error).toBe('string');
      }
    });

    it('409s when a FILE already holds the path, and never clobbers it', async () => {
      await put('mk-file.md', 'precious');
      const res = await mkdirReq({ path: 'mk-file.md' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('conflict');
      const still = await fetch(url('/api/projects/1/file', { path: 'mk-file.md' }));
      expect(await still.text()).toBe('precious');
    });

    it('maps containment violations the same way every other route does', async () => {
      expect((await mkdirReq({ path: '../2/injected' })).status).toBe(403);
      expect((await mkdirReq({ path: '/etc/kuhn' })).status).toBe(403);
      expect((await mkdirReq({ path: '.git/hooks' })).status).toBe(400);
      expect((await mkdirReq({ path: '.' })).status).toBe(400);
      expect((await fetch(url('/api/projects/99/files/mkdir'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'x' }),
      })).status).toBe(404);
    });
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

  describe('tenancy guard (story 010-003)', () => {
    const state = orgsDb.__accessState;
    const grant = (role, reason = null) => { state.role = role; state.reason = reason; };
    afterEach(() => grant('owner'));

    const writes = () => [
      ['PUT file', () => fetch(url('/api/projects/1/file', { path: 'draft/main.md' }), {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'nope',
      })],
      ['DELETE file', () => fetch(url('/api/projects/1/file', { path: 'draft/main.md' }), { method: 'DELETE' })],
      ['mkdir', () => fetch(url('/api/projects/1/files/mkdir'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'x' }),
      })],
      ['move', () => fetch(url('/api/projects/1/files/move'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'draft/main.md', to: 'a.md' }),
      })],
      ['upload', () => {
        const form = new FormData();
        form.append('files', new Blob(['x'], { type: 'text/plain' }), 'guard.txt');
        return fetch(url('/api/projects/1/files/upload'), { method: 'POST', body: form });
      }],
    ];

    it('404s non-members on reads AND writes without leaking existence', async () => {
      grant('owner', 'not-member');
      const read = await fetch(url('/api/projects/1/files'));
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({ error: 'project not found' });
      for (const [name, go] of writes()) {
        expect((await go()).status, name).toBe(404);
      }
    });

    it('viewers read (tree + file) but every write 403s with the role error', async () => {
      grant('viewer');
      expect((await fetch(url('/api/projects/1/files'))).status).toBe(200);
      expect((await fetch(url('/api/projects/1/file', { path: 'draft/main.md' }))).status).toBe(200);
      for (const [name, go] of writes()) {
        const res = await go();
        expect(res.status, name).toBe(403);
        expect(await res.json(), name).toEqual({ error: 'requires editor role' });
      }
      // Nothing landed on disk.
      expect((await fetch(url('/api/projects/1/file', { path: 'guard.txt' }))).status).toBe(404);
    });

    it('editors clear the write threshold', async () => {
      grant('editor');
      const res = await fetch(url('/api/projects/1/file', { path: 'editor-ok.md' }), {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'fine',
      });
      expect(res.status).toBe(201);
    });

    it('403s everyone once the org is suspended', async () => {
      grant('owner', 'suspended');
      const res = await fetch(url('/api/projects/1/files'));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'organization suspended' });
    });
  });
});
