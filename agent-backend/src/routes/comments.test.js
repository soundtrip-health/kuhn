// Story 008-004: HTTP contract of the comments routes, including the
// project-membership guard (stricter than the file routes — see comments.js).
// Real in-memory SQLite; only the event hub is mocked.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let publishProjectEvent;
let server;
let base;
let PROJECT_ID;
const USER = 9;

// Mutable per-test identity, injected by the session stand-in below.
let sessionUser;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, '..', 'db', 'schema.sql'), 'utf-8'));
  ({ publishProjectEvent } = await import('../project-events.js'));
  const { default: router } = await import('./comments.js');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = sessionUser; next(); });
  app.use(router);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = { id: USER, email: 'dev@kuhn.local' };
  querySync('DELETE FROM comments');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'dev@kuhn.local', 'Dev User')", [USER]);
  querySync("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, 1, 'owner')", [USER]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
});

const url = (path) => new URL(path, base);
const json = { 'Content-Type': 'application/json' };
const post = (path, body) => fetch(url(path), { method: 'POST', headers: json, body: JSON.stringify(body) });
const patch = (path, body) => fetch(url(path), { method: 'PATCH', headers: json, body: JSON.stringify(body) });

const createViaApi = async (over = {}) => {
  const res = await post(`/api/projects/${PROJECT_ID}/comments`, {
    path: 'draft/main.md', body: 'Needs a citation.',
    anchor: { quote: 'claims data', start: 10, end: 21 }, ...over,
  });
  expect(res.status).toBe(201);
  return res.json();
};

describe('comment routes (story 008-004)', () => {
  it('POST creates a thread, attributes the session user, and emits a comment event', async () => {
    const t = await createViaApi();
    expect(t).toMatchObject({
      path: 'draft/main.md', body: 'Needs a citation.', userId: USER,
      agent: null, anchor: { quote: 'claims data', start: 10, end: 21 }, replies: [],
    });
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, {
      type: 'comment', action: 'create', path: 'draft/main.md', id: t.id, rootId: t.id, agent: null,
    }, { userId: USER });
  });

  it('GET lists threads with nested replies, filtered by path', async () => {
    const t = await createViaApi();
    await createViaApi({ path: 'draft/other.md' });
    const reply = await (await post(`/api/projects/${PROJECT_ID}/comments/${t.id}/replies`, { body: 'On it.' })).json();
    expect(reply).toMatchObject({ parentId: t.id, body: 'On it.' });

    const all = await (await fetch(url(`/api/projects/${PROJECT_ID}/comments`))).json();
    expect(all.threads).toHaveLength(2);
    const scoped = await (await fetch(url(`/api/projects/${PROJECT_ID}/comments?path=draft/main.md`))).json();
    expect(scoped.threads).toHaveLength(1);
    expect(scoped.threads[0].replies.map((r) => r.body)).toEqual(['On it.']);
  });

  it('resolve/reopen round-trips and counts unresolved threads per path', async () => {
    const t = await createViaApi();
    await createViaApi({ path: 'draft/other.md' });
    const resolved = await (await post(`/api/projects/${PROJECT_ID}/comments/${t.id}/resolve`, {})).json();
    expect(resolved.resolvedAt).toBeTruthy();
    const counts = await (await fetch(url(`/api/projects/${PROJECT_ID}/comments/counts`))).json();
    expect(counts.counts).toEqual({ 'draft/other.md': 1 });
    const reopened = await (await post(`/api/projects/${PROJECT_ID}/comments/${t.id}/reopen`, {})).json();
    expect(reopened.resolvedAt).toBeNull();
  });

  it('PATCH anchor updates offsets and the orphan flag without a feed event', async () => {
    const t = await createViaApi();
    vi.clearAllMocks();
    const moved = await (await patch(`/api/projects/${PROJECT_ID}/comments/${t.id}/anchor`, { start: 40, end: 51, orphaned: true })).json();
    expect(moved.anchor).toMatchObject({ start: 40, end: 51 });
    expect(moved.orphaned).toBe(true);
    expect(publishProjectEvent).not.toHaveBeenCalled();
  });

  it('DELETE is author-only', async () => {
    const t = await createViaApi();
    sessionUser = { id: 77, email: 'other@kuhn.local' };
    querySync("INSERT INTO users (id, email) VALUES (77, 'other@kuhn.local')");
    querySync("INSERT INTO memberships (user_id, org_id, role) VALUES (77, 1, 'member')");
    const denied = await fetch(url(`/api/projects/${PROJECT_ID}/comments/${t.id}`), { method: 'DELETE' });
    expect(denied.status).toBe(403);
    sessionUser = { id: USER, email: 'dev@kuhn.local' };
    const ok = await fetch(url(`/api/projects/${PROJECT_ID}/comments/${t.id}`), { method: 'DELETE' });
    expect(ok.status).toBe(200);
  });

  it('validates bodies and ids', async () => {
    expect((await post(`/api/projects/${PROJECT_ID}/comments`, { path: 'draft/main.md', body: '   ' })).status).toBe(400);
    expect((await post(`/api/projects/${PROJECT_ID}/comments`, { body: 'x' })).status).toBe(400);
    expect((await post(`/api/projects/${PROJECT_ID}/comments/nope/resolve`, {})).status).toBe(400);
    expect((await post(`/api/projects/${PROJECT_ID}/comments/12345/resolve`, {})).status).toBe(404);
  });

  it('404s for non-members and unknown projects without leaking existence', async () => {
    await createViaApi();
    sessionUser = { id: 50, email: 'outsider@kuhn.local' };
    querySync("INSERT INTO users (id, email) VALUES (50, 'outsider@kuhn.local')");
    const res = await fetch(url(`/api/projects/${PROJECT_ID}/comments`));
    expect(res.status).toBe(404);
    sessionUser = { id: USER, email: 'dev@kuhn.local' };
    expect((await fetch(url('/api/projects/999999/comments'))).status).toBe(404);
  });
});
