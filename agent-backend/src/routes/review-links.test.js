// Epic 013 story 003: HTTP contract of the member review-link routes —
// mint/list/revoke behind the getProject + isMember guard. Real in-memory
// SQLite and real storage (temp projects root); the event hub and the collab
// socket registry are mocked (the WS side is yjs-websocket.test.js's job).

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../project-events.js', () => ({ publishProjectEvent: vi.fn() }));
vi.mock('../yjs-websocket.js', () => ({
  CLOSE_LINK_REVOKED: 4003,
  closeReviewerConnections: vi.fn(),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

let querySync;
let config;
let publishProjectEvent;
let closeReviewerConnections;
let server;
let base;
let root;
let PROJECT_ID;
const USER = 9;

// Mutable per-test identity, injected by the session stand-in below.
let sessionUser;

beforeAll(async () => {
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, '..', 'db', 'schema.sql'), 'utf-8'));
  ({ config } = await import('../config.js'));
  root = await mkdtemp(join(tmpdir(), 'kuhn-review-links-'));
  config.agent.projectsRoot = root;
  ({ publishProjectEvent } = await import('../project-events.js'));
  ({ closeReviewerConnections } = await import('../yjs-websocket.js'));
  const { default: router } = await import('./review-links.js');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = sessionUser; next(); });
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
  sessionUser = { id: USER, email: 'dev@kuhn.local' };
  querySync('DELETE FROM review_sessions');
  querySync('DELETE FROM review_links');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync("INSERT INTO users (id, email, display_name) VALUES ($1, 'dev@kuhn.local', 'Dev User')", [USER]);
  querySync("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, 1, 'member')", [USER]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PROJECT_ID = rows[0].id;
  await mkdir(join(root, String(PROJECT_ID), 'draft'), { recursive: true });
  await writeFile(join(root, String(PROJECT_ID), 'draft', 'main.md'), '# Draft\n');
});

const url = (path) => new URL(path, base);
const json = { 'Content-Type': 'application/json' };
const post = (path, body) => fetch(url(path), { method: 'POST', headers: json, body: JSON.stringify(body) });
const mint = (over = {}) => post(`/api/projects/${PROJECT_ID}/review-links`, {
  path: 'draft/main.md', mode: 'comment', ...over,
});

describe('review-link routes (epic 013 story 003)', () => {
  it('mints a link: url with the raw token once, shaped link, no hashes, mint feed event', async () => {
    const res = await mint();
    expect(res.status).toBe(201);
    const { url: linkUrl, link } = await res.json();
    expect(linkUrl).toMatch(/^http:\/\/localhost:\d+\/review\/[A-Za-z0-9_-]{40,}$/);
    expect(link).toMatchObject({
      projectId: PROJECT_ID, path: 'draft/main.md', mode: 'comment',
      // createdByName joins only on the list path (U1 shape) — null at mint.
      createdBy: USER, createdByName: null, reviewerName: null,
      claimedAt: null, revokedAt: null,
    });
    expect(link.expiresAt > new Date().toISOString()).toBe(true);
    expect(JSON.stringify(link)).not.toMatch(/hash/i);
    // The row stores only the hash of the URL token.
    const token = linkUrl.split('/review/')[1];
    const { rows } = querySync('SELECT token_hash FROM review_links WHERE id = $1', [link.id]);
    expect(rows[0].token_hash).not.toBe(token);
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, {
      type: 'review_link', action: 'mint', linkId: link.id, path: 'draft/main.md', mode: 'comment',
    }, { userId: USER });
  });

  it('validates mode, path, and document existence', async () => {
    expect((await mint({ mode: 'admin' })).status).toBe(400);
    expect((await mint({ path: '' })).status).toBe(400);
    expect((await mint({ path: 'draft/nope.md' })).status).toBe(404);
    expect(publishProjectEvent).not.toHaveBeenCalled();
  });

  it('lists links for the panel, filtered by path, revoked rows on demand', async () => {
    const a = (await (await mint()).json()).link;
    await mint({ path: 'draft/other.md', mode: 'view' }).then(async (r) => {
      // other.md does not exist → mint refused; create it and re-mint
      expect(r.status).toBe(404);
    });
    await writeFile(join(root, String(PROJECT_ID), 'draft', 'other.md'), 'x\n');
    const b = (await (await mint({ path: 'draft/other.md', mode: 'view' })).json()).link;
    await post(`/api/projects/${PROJECT_ID}/review-links/${b.id}/revoke`, {});

    const all = await (await fetch(url(`/api/projects/${PROJECT_ID}/review-links`))).json();
    expect(all.links.map((l) => l.id)).toEqual([a.id]);
    const withRevoked = await (await fetch(
      url(`/api/projects/${PROJECT_ID}/review-links?includeRevoked=1`),
    )).json();
    expect(withRevoked.links).toHaveLength(2);
    const scoped = await (await fetch(
      url(`/api/projects/${PROJECT_ID}/review-links?path=draft/main.md`),
    )).json();
    expect(scoped.links.map((l) => l.id)).toEqual([a.id]);
  });

  it('revoke kills sessions, closes that link\'s sockets, and tells the feed', async () => {
    const { link } = await (await mint()).json();
    querySync(
      "INSERT INTO review_sessions (token_hash, link_id, expires_at) VALUES ('h', $1, $2)",
      [link.id, link.expiresAt],
    );
    const res = await post(`/api/projects/${PROJECT_ID}/review-links/${link.id}/revoke`, {});
    expect(res.status).toBe(200);
    const { link: revoked } = await res.json();
    expect(revoked.revokedAt).toBeTruthy();
    expect(revoked.revokedBy).toBe(USER);
    expect(querySync('SELECT 1 FROM review_sessions WHERE link_id = $1', [link.id]).rows).toHaveLength(0);
    expect(closeReviewerConnections).toHaveBeenCalledWith(link.id, { code: 4003, reason: 'Link revoked' });
    expect(publishProjectEvent).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
      type: 'review_link', action: 'revoke', linkId: link.id, path: 'draft/main.md',
    }), { userId: USER });
    expect((await post(`/api/projects/${PROJECT_ID}/review-links/999/revoke`, {})).status).toBe(404);
    expect((await post(`/api/projects/${PROJECT_ID}/review-links/nope/revoke`, {})).status).toBe(400);
  });

  it('404s for non-members and unknown projects without leaking existence', async () => {
    sessionUser = { id: 50, email: 'outsider@kuhn.local' };
    querySync("INSERT INTO users (id, email) VALUES (50, 'outsider@kuhn.local')");
    expect((await mint()).status).toBe(404);
    expect((await fetch(url(`/api/projects/${PROJECT_ID}/review-links`))).status).toBe(404);
    sessionUser = { id: USER, email: 'dev@kuhn.local' };
    expect((await fetch(url('/api/projects/999999/review-links'))).status).toBe(404);
  });
});
