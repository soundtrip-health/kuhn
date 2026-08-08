// Epic 013 §5.1: the route-allowlist matrix — the invariant-bearing test of
// the epic. The FULL router stack is mounted in production order (auth →
// review guest → session → every tenant router) with auth.mode forced to
// 'magic-link': dev mode would vacuously resolve a member for every request,
// so the guest/member wall must be proven non-dev. Real in-memory SQLite,
// real storage (temp projects root), real event hub; only the collab socket
// layer and version history are mocked (theirs are separate suites).
//
// The structural claim under test: a guest carries ONLY kuhn_review_session,
// which session() cannot see → every non-/api/review route 401s before any
// handler; and /api/review/* is scoped to exactly one document per link.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

// The collab layer is yjs-websocket.test.js's suite; here it must only exist.
vi.mock('../yjs-websocket.js', () => ({
  CLOSE_ROOM_EVICTED: 4001,
  CLOSE_ROOM_MOVED: 4002,
  CLOSE_LINK_REVOKED: 4003,
  CLOSE_LINK_EXPIRED: 4004,
  evictRoom: vi.fn(),
  evictRoomsUnder: vi.fn(),
  plantMoveTombstone: vi.fn(),
  clearMoveTombstonesUnder: vi.fn(),
  hasRoom: vi.fn(() => false),
  closeReviewerConnections: vi.fn(),
}));

// History is mocked so the matrix can assert reviewer meta THREADING (the
// checkpoint-attribution fix) without spawning git; history.test.js proves
// what the meta does inside commitNow/listHistory.
vi.mock('../history.js', () => ({
  commitNow: vi.fn(async () => null),
  scheduleCommit: vi.fn(),
  flushProject: vi.fn(async () => {}),
  fileAtVersion: vi.fn(async () => Buffer.from('')),
  listHistory: vi.fn(async () => []),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODES = ['view', 'comment', 'edit'];
const MEMBER = 9;
const OUTSIDER = 50;

let querySync;
let config;
let db;
let commentsDb;
let reviewLinksDb;
let history;
let collab;
let subscribeProjectEvents;
let server;
let base;
let root;
let PID;
let memberCookie;   // full Cookie header value for the org member
let outsiderCookie; // session for a user with no membership
// Per mode: { linkId, token, cookie } — cookie is the Cookie header value.
const links = {};

const guest = (mode) => ({ Cookie: `kuhn_review_session=${encodeURIComponent(links[mode].cookie)}` });
const member = () => ({ Cookie: `kuhn_session=${encodeURIComponent(memberCookie)}` });
const outsider = () => ({ Cookie: `kuhn_session=${encodeURIComponent(outsiderCookie)}` });

const url = (path) => new URL(path, base);
const jsonHeaders = { 'Content-Type': 'application/json' };
const req = (method, path, { headers = {}, body } = {}) => fetch(url(path), {
  method,
  headers: body !== undefined ? { ...jsonHeaders, ...headers } : headers,
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

/** Mint + claim a fresh link directly through the store; returns headers too. */
function makeClaimedLink(mode, name = 'Fresh Reviewer', path = 'draft/main.md') {
  const { token, link } = reviewLinksDb.createReviewLink({
    projectId: PID, path, mode, createdBy: MEMBER,
  });
  const claim = reviewLinksDb.claimReviewLink(token, name);
  expect(claim.ok).toBe(true);
  return {
    linkId: link.id,
    token,
    cookie: claim.cookieValue,
    headers: { Cookie: `kuhn_review_session=${encodeURIComponent(claim.cookieValue)}` },
  };
}

/** Collect this project's feed events for the duration of `fn`. */
async function collectEvents(fn) {
  const events = [];
  const unsubscribe = subscribeProjectEvents(PID, (e) => events.push(e));
  try {
    await fn();
  } finally {
    unsubscribe();
  }
  return events;
}

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  // NON-DEV: in dev mode session() resolves the seeded dev user for any
  // request and the whole deny matrix would pass vacuously.
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'matrix-test-secret';
  root = await mkdtemp(join(tmpdir(), 'kuhn-review-matrix-'));
  config.agent.projectsRoot = root;

  db = await import('../db.js');
  querySync = db.querySync;
  db.exec(readFileSync(resolve(__dirname, '..', 'db', 'schema.sql'), 'utf-8'));

  commentsDb = await import('../db/comments.js');
  reviewLinksDb = await import('../db/review-links.js');
  history = await import('../history.js');
  collab = await import('../yjs-websocket.js');
  ({ subscribeProjectEvents } = await import('../project-events.js'));

  // Fixtures: org, member (+ session cookie), membership-less outsider,
  // project, the linked document on disk.
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org', 'org')");
  querySync(
    "INSERT INTO users (id, email, display_name) VALUES ($1, 'pi@lab.test', 'Dr. PI'), ($2, 'outsider@lab.test', 'Outsider')",
    [MEMBER, OUTSIDER],
  );
  querySync("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, 1, 'editor')", [MEMBER]);
  const { rows } = querySync(
    "INSERT INTO projects (org_id, name, project_type) VALUES (1, 'P', 'manuscript') RETURNING id",
  );
  PID = rows[0].id;
  await mkdir(join(root, String(PID), 'draft'), { recursive: true });
  await writeFile(join(root, String(PID), 'draft', 'main.md'), '# Draft\n');
  await writeFile(join(root, String(PID), 'draft', 'other.md'), '# Other\n');

  const auth = await import('../db/auth.js');
  memberCookie = (await auth.createSession(MEMBER)).cookieValue;
  outsiderCookie = (await auth.createSession(OUTSIDER)).cookieValue;

  // One claimed link per mode on draft/main.md.
  for (const mode of MODES) {
    const { token, link } = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode, createdBy: MEMBER,
    });
    const claim = reviewLinksDb.claimReviewLink(token, `${mode[0].toUpperCase()}${mode.slice(1)} Reviewer`);
    expect(claim.ok).toBe(true);
    links[mode] = { linkId: link.id, token, cookie: claim.cookieValue };
  }

  // Production mount order (index.js): health → auth → review guest →
  // [static] → session → every tenant router → review-links member router.
  const { session } = await import('../session.js');
  const { authRouter, meRouter } = await import('./auth.js');
  const routers = {
    health: (await import('./health.js')).default,
    review: (await import('./review.js')).default,
    agent: (await import('./agent.js')).default,
    citations: (await import('./citations.js')).default,
    comments: (await import('./comments.js')).default,
    files: (await import('./files.js')).default,
    history: (await import('./history.js')).default,
    orgs: (await import('./orgs.js')).default,
    orgLibrary: (await import('./org-library.js')).default,
    pendingEdits: (await import('./pending-edits.js')).default,
    projects: (await import('./projects.js')).default,
    render: (await import('./render.js')).default,
    reviewLinks: (await import('./review-links.js')).default,
  };
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(routers.health);
  app.use(authRouter);
  app.use(routers.review);
  app.use(session);
  app.use(meRouter);
  app.use(routers.agent);
  app.use(routers.citations);
  app.use(routers.comments);
  app.use(routers.files);
  app.use(routers.history);
  app.use(routers.orgs);
  app.use(routers.orgLibrary);
  app.use(routers.pendingEdits);
  app.use(routers.projects);
  app.use(routers.render);
  app.use(routers.reviewLinks);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  querySync('DELETE FROM comments');
  querySync('DELETE FROM file_events');
  await writeFile(join(root, String(PID), 'draft', 'main.md'), '# Draft\n');
});

// ---- Allowlisted guest routes, per mode --------------------------------------

describe('guest allowlist (§2.4 matrix)', () => {
  it('context and file reads succeed in every mode; context is the link\'s scope', async () => {
    for (const mode of MODES) {
      const ctxRes = await req('GET', '/api/review/context', { headers: guest(mode) });
      expect(ctxRes.status).toBe(200);
      expect(await ctxRes.json()).toMatchObject({
        projectId: PID, path: 'draft/main.md', mode, docTitle: 'main.md',
      });
      const fileRes = await req('GET', '/api/review/file', { headers: guest(mode) });
      expect(fileRes.status).toBe(200);
      expect(await fileRes.text()).toBe('# Draft\n');
      const commentsRes = await req('GET', '/api/review/comments', { headers: guest(mode) });
      expect(commentsRes.status).toBe(200);
    }
  });

  it('PUT /api/review/file is edit-only', async () => {
    for (const mode of ['view', 'comment']) {
      const res = await fetch(url('/api/review/file'), {
        method: 'PUT', headers: guest(mode), body: 'overwritten\n',
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('mode_forbidden');
    }
    expect(await readFile(join(root, String(PID), 'draft', 'main.md'), 'utf-8')).toBe('# Draft\n');
  });

  it('edit PUT writes the doc, threads reviewer meta, and feeds once per window', async () => {
    const events = await collectEvents(async () => {
      const res = await fetch(url('/api/review/file'), {
        method: 'PUT', headers: guest('edit'), body: 'edited by reviewer\n',
      });
      expect(res.status).toBe(200);
      // Autosave #2 inside the same 5-minute window.
      await fetch(url('/api/review/file'), {
        method: 'PUT', headers: guest('edit'), body: 'edited again\n',
      });
    });
    expect(await readFile(join(root, String(PID), 'draft', 'main.md'), 'utf-8')).toBe('edited again\n');
    // Version attribution: autosaves schedule with reviewer meta.
    expect(history.scheduleCommit).toHaveBeenCalledWith(PID, {
      reviewer: { linkId: links.edit.linkId, name: 'Edit Reviewer' },
    });
    // Debounced feed truth: ONE file_events row and ONE live event per window.
    const { rows } = querySync(
      "SELECT review_link_id, kind FROM file_events WHERE project_id = $1 AND path = 'draft/main.md'",
      [PID],
    );
    expect(rows).toEqual([{ review_link_id: links.edit.linkId, kind: 'update' }]);
    const edits = events.filter((e) => e.type === 'review_link' && e.action === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      linkId: links.edit.linkId, path: 'draft/main.md', mode: 'edit', name: 'Edit Reviewer',
    });
  });

  it('?checkpoint=1 commits now with the reviewerCheckpoint flag (013 attribution fix)', async () => {
    const res = await fetch(url('/api/review/file?checkpoint=1'), {
      method: 'PUT', headers: guest('edit'), body: 'checkpointed\n',
    });
    expect(res.status).toBe(200);
    expect(history.commitNow).toHaveBeenCalledWith(PID, {
      reviewer: { linkId: links.edit.linkId, name: 'Edit Reviewer' },
      reviewerCheckpoint: true,
      label: 'Save draft/main.md',
    });
  });

  it('comment creation is mode-gated, forced to the linked doc, and reviewer-attributed', async () => {
    const denied = await req('POST', '/api/review/comments', {
      headers: guest('view'), body: { body: 'sneaky' },
    });
    expect(denied.status).toBe(403);

    for (const mode of ['comment', 'edit']) {
      const res = await req('POST', '/api/review/comments', {
        headers: guest(mode),
        // Body path must be IGNORED — the thread lands on the link's doc.
        body: { path: 'draft/other.md', body: 'External note', anchor: { quote: 'Draft' } },
      });
      expect(res.status).toBe(201);
      const thread = await res.json();
      expect(thread).toMatchObject({
        path: 'draft/main.md',
        userId: null,
        reviewLinkId: links[mode].linkId,
        body: 'External note',
      });
      expect(thread.reviewerName).toMatch(/Reviewer$/);
    }
  });

  it('replies work on any thread of the linked doc, never on another doc\'s', async () => {
    const memberThread = commentsDb.createThread(PID, {
      path: 'draft/main.md', body: 'member note', userId: MEMBER,
    });
    const elsewhere = commentsDb.createThread(PID, {
      path: 'draft/other.md', body: 'other doc', userId: MEMBER,
    });
    expect((await req('POST', `/api/review/comments/${memberThread.id}/replies`, {
      headers: guest('view'), body: { body: 'nope' },
    })).status).toBe(403);
    const ok = await req('POST', `/api/review/comments/${memberThread.id}/replies`, {
      headers: guest('comment'), body: { body: 'reviewer reply' },
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({
      parentId: memberThread.id, userId: null, reviewLinkId: links.comment.linkId,
    });
    // A thread on a different doc in the SAME project is a plain 404.
    expect((await req('POST', `/api/review/comments/${elsewhere.id}/replies`, {
      headers: guest('comment'), body: { body: 'cross-doc' },
    })).status).toBe(404);
  });

  it('resolve/reopen: own threads only, stamped resolved_by_link_id', async () => {
    const memberThread = commentsDb.createThread(PID, {
      path: 'draft/main.md', body: 'member note', userId: MEMBER,
    });
    const own = await (await req('POST', '/api/review/comments', {
      headers: guest('comment'), body: { body: 'mine' },
    })).json();

    expect((await req('POST', `/api/review/comments/${own.id}/resolve`, {
      headers: guest('view'), body: {},
    })).status).toBe(403);
    // Someone else's thread → 403 even in comment/edit mode.
    expect((await req('POST', `/api/review/comments/${memberThread.id}/resolve`, {
      headers: guest('comment'), body: {},
    })).status).toBe(403);
    // Another link's thread is not "own" either.
    expect((await req('POST', `/api/review/comments/${own.id}/resolve`, {
      headers: guest('edit'), body: {},
    })).status).toBe(403);

    const resolved = await (await req('POST', `/api/review/comments/${own.id}/resolve`, {
      headers: guest('comment'), body: {},
    })).json();
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedByLinkId).toBe(links.comment.linkId);
    expect(resolved.resolvedBy).toBeNull();
    const reopened = await (await req('POST', `/api/review/comments/${own.id}/reopen`, {
      headers: guest('comment'), body: {},
    })).json();
    expect(reopened.resolvedAt).toBeNull();
  });

  it('DELETE: own comments only', async () => {
    const memberThread = commentsDb.createThread(PID, {
      path: 'draft/main.md', body: 'member note', userId: MEMBER,
    });
    const own = await (await req('POST', '/api/review/comments', {
      headers: guest('comment'), body: { body: 'mine' },
    })).json();
    expect((await req('DELETE', `/api/review/comments/${own.id}`, {
      headers: guest('view'),
    })).status).toBe(403);
    expect((await req('DELETE', `/api/review/comments/${memberThread.id}`, {
      headers: guest('comment'),
    })).status).toBe(403);
    expect((await req('DELETE', `/api/review/comments/${own.id}`, {
      headers: guest('edit'),
    })).status).toBe(403); // another link's comment
    expect((await req('DELETE', `/api/review/comments/${own.id}`, {
      headers: guest('comment'),
    })).status).toBe(200);
  });

  it('anchor PATCH is edit-only', async () => {
    const own = await (await req('POST', '/api/review/comments', {
      headers: guest('edit'), body: { body: 'anchored', anchor: { quote: 'Draft', start: 2, end: 7 } },
    })).json();
    for (const mode of ['view', 'comment']) {
      expect((await req('PATCH', `/api/review/comments/${own.id}/anchor`, {
        headers: guest(mode), body: { start: 3, end: 8 },
      })).status).toBe(403);
    }
    const res = await req('PATCH', `/api/review/comments/${own.id}/anchor`, {
      headers: guest('edit'), body: { start: 3, end: 8, orphaned: false },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).anchor).toMatchObject({ start: 3, end: 8 });
  });
});

// ---- The deny sweep ----------------------------------------------------------

describe('deny sweep: every other route family 401s for guests', () => {
  const denied = () => [
    ['GET', '/api/projects'],
    ['GET', `/api/projects/${PID}/files`],
    // The guest must not reach the PARAMETERIZED file route even for the very
    // doc the link covers — only /api/review/file, which takes no path.
    ['GET', `/api/projects/${PID}/file?path=draft/main.md`],
    ['PUT', `/api/projects/${PID}/file?path=draft/main.md`],
    ['DELETE', `/api/projects/${PID}/file?path=draft/main.md`],
    ['POST', `/api/projects/${PID}/files/move`],
    ['GET', `/api/projects/${PID}/history?path=draft/main.md`],
    ['GET', `/api/projects/${PID}/pending-edits`],
    ['GET', `/api/projects/${PID}/comments`],
    ['GET', `/api/projects/${PID}/events`],
    ['POST', '/api/agent/task'],
    ['GET', `/api/projects/${PID}/citations/search?q=x`],
    ['POST', `/api/projects/${PID}/citations`],
    ['GET', `/api/projects/${PID}/references`],
    ['POST', `/api/projects/${PID}/render`],
    ['GET', `/api/projects/${PID}/export`],
    ['GET', '/api/orgs'],
    // The org namespace as a whole must stay shut — org id 1 is the seeded
    // default tenant, which is exactly the one a guest must never enter.
    ['GET', '/api/orgs/1/library'],
    ['POST', '/api/orgs/1/library/upload'],
    ['GET', '/api/orgs/1/library/1'],
    ['GET', '/api/orgs/1/library/1/content'],
    ['DELETE', '/api/orgs/1/library/1'],
    ['GET', '/api/orgs/1/events'],
    ['GET', '/api/auth/me'],
    ['POST', `/api/projects/${PID}/review-links`],
    ['GET', `/api/projects/${PID}/review-links`],
    ['POST', `/api/projects/${PID}/review-links/${links.view?.linkId ?? 1}/revoke`],
  ];

  const sweep = (method, path, headers) =>
    req(method, path, { headers, ...(method === 'GET' ? {} : { body: {} }) });

  for (const mode of MODES) {
    it(`${mode}-mode session reaches no member route`, async () => {
      for (const [method, path] of denied()) {
        const res = await sweep(method, path, guest(mode));
        expect(res.status, `${mode} ${method} ${path}`).toBe(401);
      }
    });
  }

  it('no cookie at all is equally shut out', async () => {
    for (const [method, path] of denied()) {
      expect((await sweep(method, path, {})).status, `${method} ${path}`).toBe(401);
    }
  });

  it('the door swings both ways: a member session is not a review session', async () => {
    for (const path of ['/api/review/context', '/api/review/file', '/api/review/comments']) {
      const res = await req('GET', path, { headers: member() });
      expect(res.status, path).toBe(401);
      expect((await res.json()).code).toBe('review_session_invalid');
    }
  });
});

// ---- Lookup & claim ----------------------------------------------------------

describe('lookup and claim lifecycle', () => {
  it('lookup distinguishes unknown/unclaimed/claimed/expired/revoked/yours', async () => {
    expect((await req('POST', '/api/review/lookup', { body: { token: 'no-such-token' } })).status).toBe(404);

    const fresh = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'comment', createdBy: MEMBER,
    });
    expect(await (await req('POST', '/api/review/lookup', { body: { token: fresh.token } })).json())
      .toMatchObject({ state: 'unclaimed', mode: 'comment', docTitle: 'main.md' });

    // Claimed by someone else (no cookie presented).
    expect(await (await req('POST', '/api/review/lookup', { body: { token: links.view.token } })).json())
      .toMatchObject({ state: 'claimed', reviewerName: 'View Reviewer' });

    // Same browser that claimed it → 'yours' with a ready context.
    expect(await (await req('POST', '/api/review/lookup', {
      headers: guest('view'), body: { token: links.view.token },
    })).json()).toMatchObject({
      state: 'yours', context: { projectId: PID, path: 'draft/main.md', mode: 'view' },
    });

    const expired = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'view', createdBy: MEMBER,
    });
    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      [expired.link.id]);
    expect((await (await req('POST', '/api/review/lookup', { body: { token: expired.token } })).json()).state)
      .toBe('expired');

    const revoked = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'view', createdBy: MEMBER,
    });
    reviewLinksDb.revokeReviewLink(PID, revoked.link.id, { revokedBy: MEMBER });
    expect((await (await req('POST', '/api/review/lookup', { body: { token: revoked.token } })).json()).state)
      .toBe('revoked');
  });

  it('claim sets the review cookie, returns context, feeds the claim, and single-claims', async () => {
    const fresh = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'comment', createdBy: MEMBER,
    });
    let res;
    const events = await collectEvents(async () => {
      res = await req('POST', '/api/review/claim', { body: { token: fresh.token, name: '  Jane   Q. ' } });
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/^kuhn_review_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\//);
    expect((await res.json()).context).toMatchObject({
      projectId: PID, path: 'draft/main.md', mode: 'comment',
      name: 'Jane Q.', docTitle: 'main.md',
    });
    expect(events.filter((e) => e.type === 'review_link' && e.action === 'claim')).toHaveLength(1);

    // Single-claim discipline: the three refusal states are distinct.
    const again = await req('POST', '/api/review/claim', { body: { token: fresh.token, name: 'Mallory' } });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('link_claimed');
  });

  it('claiming expired/revoked/unknown links refuses with distinct codes', async () => {
    const expired = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'view', createdBy: MEMBER,
    });
    querySync("UPDATE review_links SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      [expired.link.id]);
    const e = await req('POST', '/api/review/claim', { body: { token: expired.token, name: 'Jane' } });
    expect([e.status, (await e.json()).code]).toEqual([410, 'link_expired']);

    const revoked = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'view', createdBy: MEMBER,
    });
    reviewLinksDb.revokeReviewLink(PID, revoked.link.id, { revokedBy: MEMBER });
    const r = await req('POST', '/api/review/claim', { body: { token: revoked.token, name: 'Jane' } });
    expect([r.status, (await r.json()).code]).toEqual([410, 'link_revoked']);

    const u = await req('POST', '/api/review/claim', { body: { token: 'no-such-token', name: 'Jane' } });
    expect([u.status, (await u.json()).code]).toEqual([404, 'link_not_found']);

    const fresh = reviewLinksDb.createReviewLink({
      projectId: PID, path: 'draft/main.md', mode: 'view', createdBy: MEMBER,
    });
    expect((await req('POST', '/api/review/claim', { body: { token: fresh.token, name: '   ' } })).status)
      .toBe(400);
  });
});

// ---- Suspension (011-001, fix MA2) --------------------------------------------

describe('suspension covers the reviewer surface (MA2)', () => {
  const suspend = () => querySync("UPDATE organizations SET status = 'suspended' WHERE id = 1");
  const unsuspend = () => querySync("UPDATE organizations SET status = 'active' WHERE id = 1");

  it('403s every session-bearing guest route while the org is suspended, and recovers on unsuspend', async () => {
    suspend();
    try {
      // Reads refuse in every mode — an anonymous link holder must not keep
      // reading a suspended tenant's files.
      for (const mode of MODES) {
        for (const path of ['/api/review/context', '/api/review/file', '/api/review/comments']) {
          const res = await req('GET', path, { headers: guest(mode) });
          expect(res.status, `${mode} GET ${path}`).toBe(403);
          expect((await res.json()).error).toBe('organization suspended');
        }
      }
      // Writes refuse BEFORE the mode gate: even the edit link cannot write.
      const put = await fetch(url('/api/review/file'), {
        method: 'PUT', headers: guest('edit'), body: 'suspended write\n',
      });
      expect(put.status).toBe(403);
      expect(await readFile(join(root, String(PID), 'draft', 'main.md'), 'utf-8')).toBe('# Draft\n');
      const comment = await req('POST', '/api/review/comments', {
        headers: guest('comment'), body: { body: 'sneaky' },
      });
      expect(comment.status).toBe(403);
      // The member surface refuses through the tenancy chokepoint too.
      const member403 = await req('GET', `/api/projects/${PID}/files`, { headers: member() });
      expect(member403.status).toBe(403);
      expect(await member403.json()).toEqual({ error: 'organization suspended' });
    } finally {
      unsuspend();
    }
    // Reversible: the same session works again once the org is active.
    expect((await req('GET', '/api/review/context', { headers: guest('view') })).status).toBe(200);
    expect((await req('GET', `/api/projects/${PID}/files`, { headers: member() })).status).toBe(200);
  });
});

// ---- Revocation & the member side --------------------------------------------

describe('member management + revocation round trip', () => {
  it('member routes work non-dev; outsiders and the unauthenticated do not', async () => {
    expect((await req('GET', '/api/projects', { headers: member() })).status).toBe(200);
    expect((await req('POST', `/api/projects/${PID}/review-links`, {
      headers: outsider(), body: { path: 'draft/main.md', mode: 'view' },
    })).status).toBe(404); // non-member: existence not leaked
    expect((await req('POST', `/api/projects/${PID}/review-links`, {
      body: { path: 'draft/main.md', mode: 'view' },
    })).status).toBe(401);
  });

  it('mint → claim → revoke: one request cycle ends the session; feed hears all three', async () => {
    let linkId;
    let guestHeaders;
    const events = await collectEvents(async () => {
      // Mint over REST as the member.
      const mintRes = await req('POST', `/api/projects/${PID}/review-links`, {
        headers: member(), body: { path: 'draft/main.md', mode: 'comment' },
      });
      expect(mintRes.status).toBe(201);
      const { url: linkUrl, link } = await mintRes.json();
      linkId = link.id;
      const token = linkUrl.split('/review/').pop();

      // Claim over REST as the guest.
      const claimRes = await req('POST', '/api/review/claim', { body: { token, name: 'Jane' } });
      expect(claimRes.status).toBe(200);
      const cookie = claimRes.headers.get('set-cookie').split(';')[0];
      guestHeaders = { Cookie: cookie };
      expect((await req('GET', '/api/review/context', { headers: guestHeaders })).status).toBe(200);

      // Revoke over REST as the member.
      const revokeRes = await req('POST', `/api/projects/${PID}/review-links/${linkId}/revoke`, {
        headers: member(), body: {},
      });
      expect(revokeRes.status).toBe(200);
      expect((await revokeRes.json()).link.revokedAt).toBeTruthy();
    });

    // The very next guest request is refused — per-request check, no cache.
    const after = await req('GET', '/api/review/context', { headers: guestHeaders });
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('review_session_invalid');
    // Live sockets for exactly that credential are closed.
    expect(collab.closeReviewerConnections).toHaveBeenCalledWith(
      linkId, { code: 4003, reason: 'Link revoked' },
    );
    // Feed truth: mint, claim, revoke each fanned out live.
    const actions = events.filter((e) => e.type === 'review_link').map((e) => e.action);
    expect(actions).toEqual(['mint', 'claim', 'revoke']);
  });
});
