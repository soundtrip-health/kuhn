import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Real in-memory SQLite + real storage in a temp workspace (the service test
// covers the math; this suite asserts the HTTP contract). Only the two side
// effects are mocked, as in ../pending-edits.test.js.
process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../history.js', () => ({
  commitNow: vi.fn(async () => 'commit-hash'),
  scheduleCommit: vi.fn(),
}));
vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let publishProjectEvent;
let server;
let base;
let root;
let PROJECT_ID;

const BASE = Array.from({ length: 14 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const PROPOSED = BASE.replace('line2', 'LINE2').replace('line12', 'LINE12');

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, '..', 'db', 'schema.sql'), 'utf-8'));
  ({ publishProjectEvent } = await import('../project-events.js'));
  const { default: router } = await import('./pending-edits.js');

  root = await mkdtemp(join(tmpdir(), 'kuhn-pending-routes-'));
  const app = express();
  app.use(express.json());
  // Stand-in for the session middleware, so attribution is observable (007-001).
  app.use((req, _res, next) => { req.user = { id: 9, email: 'dev@kuhn.local' }; next(); });
  app.use(router);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  querySync('DELETE FROM pending_edits');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  const dir = await mkdtemp(join(root, 'p-'));
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type, root_path) VALUES (1, 'P', 'manuscript', $1) RETURNING id",
    [dir],
  );
  PROJECT_ID = rows[0].id;
  await mkdir(join(dir, 'draft'), { recursive: true });
  await writeFile(join(dir, 'draft', 'main.md'), BASE);
});

const url = (path, params = {}) => {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};

const post = (path, body) => fetch(url(path), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const proposeViaApi = async (over = {}) => {
  const res = await post(`/api/projects/${PROJECT_ID}/pending-edits`, {
    path: 'draft/main.md', proposedContent: PROPOSED, agent: 'writer', ...over,
  });
  expect(res.status).toBe(201);
  return res.json();
};

describe('pending-edit routes (story 008-001)', () => {
  it('POST creates a pending edit and returns the GET edit shape', async () => {
    const edit = await proposeViaApi();
    expect(edit).toMatchObject({
      path: 'draft/main.md', agent: 'writer', stale: false, baseMissing: false,
      proposedContent: PROPOSED,
    });
    expect(edit.hunks).toHaveLength(2);
    expect(edit.hunks[0]).toMatchObject({ index: 0, oldStart: 1 });
    expect(typeof edit.hunks[0].hash).toBe('string');
    // Live signal for other tabs: kind 'proposed', attributed to the caller.
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, {
      type: 'file_change', agent: 'writer', path: 'draft/main.md', kind: 'proposed',
    }, { jobId: null, userId: 9 });
  });

  it('GET lists refreshed edits, with an optional path filter', async () => {
    await proposeViaApi();
    await proposeViaApi({ path: 'draft/other.md', proposedContent: 'x\n' });
    const all = await (await fetch(url(`/api/projects/${PROJECT_ID}/pending-edits`))).json();
    expect(all.edits.map((e) => e.path)).toEqual(['draft/main.md', 'draft/other.md']);
    const one = await (await fetch(url(`/api/projects/${PROJECT_ID}/pending-edits`, { path: 'draft/other.md' }))).json();
    expect(one.edits.map((e) => e.path)).toEqual(['draft/other.md']);
    expect(one.edits[0]).toMatchObject({ baseMissing: true });
  });

  it('POST 400s out-of-scope paths and malformed bodies', async () => {
    for (const body of [
      { path: 'research/notes.md', proposedContent: 'x' },
      { path: 'draft-notes/x.md', proposedContent: 'x' },
      { proposedContent: 'x' },
      { path: 'draft/main.md' },
    ]) {
      const res = await post(`/api/projects/${PROJECT_ID}/pending-edits`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accept without a hunk applies everything and deletes the edit', async () => {
    const edit = await proposeViaApi();
    const res = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, remaining: 0 });
    const list = await (await fetch(url(`/api/projects/${PROJECT_ID}/pending-edits`))).json();
    expect(list.edits).toEqual([]);
    // The accept published the REAL file_change (create/update), user-attributed.
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
      type: 'file_change', path: 'draft/main.md', kind: 'update',
    }), expect.objectContaining({ userId: 9 }));
  });

  it('accept with a hunk applies just that hunk and returns the refreshed edit', async () => {
    const edit = await proposeViaApi();
    const res = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, {
      hunk: { index: 0, hash: edit.hunks[0].hash },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ applied: true, remaining: 1 });
    expect(body.edit.hunks).toHaveLength(1);
  });

  it('accept 409s on a hunk race and on a stale row; force replaces the file', async () => {
    const edit = await proposeViaApi();
    const race = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, {
      hunk: { index: 0, hash: 'deadbeef' },
    });
    expect(race.status).toBe(409);
    expect((await race.json()).code).toBe('conflict');

    // Collide with the first hunk → stale → 409 → force accepts wholesale.
    const { rows } = querySync('SELECT root_path FROM projects WHERE id = $1', [PROJECT_ID]);
    await writeFile(join(rows[0].root_path, 'draft', 'main.md'), BASE.replace('line2', 'collision'));
    const stale = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, {});
    expect(stale.status).toBe(409);
    const forced = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, { force: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ applied: true, remaining: 0 });
  });

  it('accept 400s force combined with a hunk', async () => {
    const edit = await proposeViaApi();
    const res = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, {
      force: true, hunk: { index: 0, hash: edit.hunks[0].hash },
    });
    expect(res.status).toBe(400);
  });

  it('reject without a hunk discards the edit; with a hunk it trims the proposal', async () => {
    const edit = await proposeViaApi();
    const trim = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/reject`, {
      hunk: { index: 0, hash: edit.hunks[0].hash },
    });
    expect(trim.status).toBe(200);
    const trimmed = await trim.json();
    expect(trimmed).toMatchObject({ rejected: true, remaining: 1 });

    const all = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/reject`, {});
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ rejected: true, remaining: 0 });
    // Rejects publish only the SSE-only 'proposed' kind — never a real write event.
    const kinds = publishProjectEvent.mock.calls.map(([, e]) => e.kind);
    expect(kinds.filter((k) => k !== 'proposed')).toEqual([]);
  });

  it('maps bad ids and unknown edits to 400/404, malformed hunks to 400', async () => {
    expect((await post(`/api/projects/abc/pending-edits/1/accept`, {})).status).toBe(400);
    expect((await post(`/api/projects/${PROJECT_ID}/pending-edits/abc/accept`, {})).status).toBe(400);
    expect((await post(`/api/projects/${PROJECT_ID}/pending-edits/999/accept`, {})).status).toBe(404);
    expect((await post(`/api/projects/${PROJECT_ID}/pending-edits/999/reject`, {})).status).toBe(404);
    const edit = await proposeViaApi();
    for (const hunk of [{ index: 0 }, { hash: 'x' }, { index: -1, hash: 'x' }, { index: 'a', hash: 'x' }]) {
      const res = await post(`/api/projects/${PROJECT_ID}/pending-edits/${edit.id}/accept`, { hunk });
      expect(res.status, JSON.stringify(hunk)).toBe(400);
    }
  });
});
