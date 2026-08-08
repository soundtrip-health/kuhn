import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Real in-memory SQLite + real (temp) storage roots, org-library.test.js
// style: this story's whole point is what does and does NOT reach the org
// library tables and filesystem, so it runs against the actual SQL and fs.
process.env.KUHN_SQLITE_PATH = ':memory:';

// Ingestion is the one seam mocked: "queued exactly when a document lands"
// is this suite's assertion, not the chunking pipeline itself (ingest.test.js).
vi.mock('../ingest.js', () => ({
  IngestError: class IngestError extends Error {},
  queueIngest: vi.fn(),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let promotionsRouter; let projectsRouter;
let writeProjectFile; let deleteProjectEntry;
let subscribeProjectEvents;
let queueIngest;
let server; let base;
let orgsRoot; let projectsRoot;

// Mutable per-test identity, injected by the session stand-in below.
let sessionUser;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-orgs-'));
  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-proj-'));
  config.storage.orgsRoot = orgsRoot;
  config.agent.projectsRoot = projectsRoot;

  ({ default: promotionsRouter } = await import('./promotions.js'));
  ({ default: projectsRouter } = await import('./projects.js'));
  ({ writeProjectFile, deleteProjectEntry } = await import('../storage.js'));
  ({ subscribeProjectEvents } = await import('../project-events.js'));
  ({ queueIngest } = await import('../ingest.js'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = sessionUser; next(); });
  app.use(promotionsRouter);
  app.use(projectsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(orgsRoot, { recursive: true, force: true });
  await rm(projectsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = { id: 1, email: 'dev@kuhn.local' };
  querySync('DELETE FROM promotion_requests');
  querySync('DELETE FROM auth_events');
  querySync('DELETE FROM org_documents');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Mine', 'mine'), (2, 'Theirs', 'theirs')");
  querySync(`INSERT INTO users (id, email, display_name) VALUES
    (1, 'dev@kuhn.local', 'Dev'), (2, 'editor@kuhn.local', 'Ed'),
    (3, 'viewer@kuhn.local', 'Vi'), (4, 'boss@theirs.local', 'Boss')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (1, 1, 'owner'), (2, 1, 'editor'), (3, 1, 'viewer'), (4, 2, 'owner')`);
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'P', 'manuscript')");
});

const as = (id) => { sessionUser = { id, email: `u${id}@kuhn.local` }; };
const json = { 'Content-Type': 'application/json' };

const promote = (projectId, body) => fetch(`${base}/api/projects/${projectId}/files/promote`, {
  method: 'POST', headers: json, body: JSON.stringify(body),
});
const decide = (orgId, id, verb, body = {}) => fetch(`${base}/api/orgs/${orgId}/promotions/${id}/${verb}`, {
  method: 'POST', headers: json, body: JSON.stringify(body),
});
const count = (table) => querySync(`SELECT COUNT(*) AS n FROM ${table}`).rows[0].n;

/** File a suggestion as the org-1 editor; returns the pending request. */
async function suggest(path = 'guidance/style.md', extra = {}) {
  await writeProjectFile(10, path, `# Contents of ${path}`);
  as(2);
  const res = await promote(10, { path, ...extra });
  expect(res.status).toBe(202);
  return (await res.json()).request;
}

describe('promote route policy branch (story 011-004)', () => {
  it('files a pending request for an editor under approval-required — nothing copied, nothing ingested', async () => {
    await writeProjectFile(10, 'guidance/style.md', '# House style');
    as(2); // editor; org settings default to promotion_policy 'approval-required'
    const res = await promote(10, { path: 'guidance/style.md', title: 'House style', note: 'useful' });
    expect(res.status).toBe(202);
    const { request } = await res.json();
    expect(request).toMatchObject({
      org_id: 1,
      project_id: 10,
      project_name: 'P',
      path: 'guidance/style.md',
      title: 'House style',
      note: 'useful',
      suggested_by: 2,
      suggested_by_email: 'editor@kuhn.local',
      status: 'pending',
      decided_by: null,
      org_document_id: null,
    });
    // The epic's risk #3, structurally: zero library rows, chunks, FTS
    // entries, and no ingestion queued before an owner approves.
    expect(count('org_documents')).toBe(0);
    expect(count('org_document_chunks')).toBe(0);
    expect(count('org_chunks_fts')).toBe(0);
    expect(queueIngest).not.toHaveBeenCalled();
  });

  it('keeps the owner direct path byte-for-byte (201, stored, ingest queued)', async () => {
    await writeProjectFile(10, 'sop.md', '# SOP');
    const res = await promote(10, { path: 'sop.md', title: 'SOP' });
    expect(res.status).toBe(201);
    const { document, deduped } = await res.json();
    expect(deduped).toBe(false);
    expect(document).toMatchObject({
      org_id: 1, filename: 'sop.md', title: 'SOP',
      source: 'project-promotion', source_project_id: 10, created_by: 1,
    });
    expect(queueIngest).toHaveBeenCalledWith(1, document.id);
    expect(count('promotion_requests')).toBe(0);
  });

  it("gives editors the direct path when the org opted into policy 'direct' (AC5 parity)", async () => {
    querySync(`UPDATE organizations SET settings = '{"promotion_policy":"direct"}' WHERE id = 1`);
    await writeProjectFile(10, 'sop.md', '# SOP');
    as(2);
    const res = await promote(10, { path: 'sop.md' });
    expect(res.status).toBe(201);
    expect((await res.json()).document).toMatchObject({ created_by: 2, source_project_id: 10 });
    expect(count('promotion_requests')).toBe(0);
  });

  it('returns the existing pending request (200) for a duplicate suggestion, without a second feed event', async () => {
    const events = [];
    const unsubscribe = subscribeProjectEvents(10, (e) => events.push(e));
    try {
      const first = await suggest('dup.md');
      const again = await promote(10, { path: 'dup.md' });
      expect(again.status).toBe(200);
      expect((await again.json()).request.id).toBe(first.id);
      expect(count('promotion_requests')).toBe(1);
      expect(events.filter((e) => e.type === 'promotion')).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('publishes the pending suggestion on the project feed (suggester sees it)', async () => {
    const events = [];
    const unsubscribe = subscribeProjectEvents(10, (e) => events.push(e));
    try {
      const request = await suggest('seen.md');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'promotion', requestId: request.id, path: 'seen.md', status: 'pending',
      }));
    } finally {
      unsubscribe();
    }
  });
});

describe('promotion queue routes (story 011-004)', () => {
  it('lists requests owner-only, with the status filter and joined fields', async () => {
    const a = await suggest('a.md');
    await suggest('b.md');
    as(1);
    expect((await decide(1, a.id, 'reject')).status).toBe(200);

    const all = await fetch(`${base}/api/orgs/1/promotions`);
    expect(all.status).toBe(200);
    expect((await all.json()).requests).toHaveLength(2);

    const pending = await (await fetch(`${base}/api/orgs/1/promotions?status=pending`)).json();
    expect(pending.requests).toHaveLength(1);
    expect(pending.requests[0]).toMatchObject({
      path: 'b.md', project_name: 'P', suggested_by_email: 'editor@kuhn.local', status: 'pending',
    });
    const rejected = await (await fetch(`${base}/api/orgs/1/promotions?status=rejected`)).json();
    expect(rejected.requests.map((r) => r.path)).toEqual(['a.md']);

    expect((await fetch(`${base}/api/orgs/1/promotions?status=bogus`)).status).toBe(400);

    as(2); // editor
    const forbidden = await fetch(`${base}/api/orgs/1/promotions`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'requires owner role' });
  });

  it('approve copies on approval: document stored, ingest queued, row linked', async () => {
    const request = await suggest('guidance/style.md', { title: 'House style' });
    as(1);
    const res = await decide(1, request.id, 'approve', { note: 'ship it' });
    expect(res.status).toBe(200);
    const decided = (await res.json()).request;
    expect(decided).toMatchObject({
      id: request.id,
      status: 'approved',
      decided_by: 1,
      decision_note: 'ship it',
      project_name: 'P',
      suggested_by_email: 'editor@kuhn.local',
    });
    expect(decided.decided_at).toBeTruthy();
    expect(decided.org_document_id).toBeTruthy();

    // Stored via the existing promote path — same row shape as direct
    // promote, attributed to the suggester.
    const doc = querySync('SELECT * FROM org_documents WHERE id = $1', [decided.org_document_id]).rows[0];
    expect(doc).toMatchObject({
      org_id: 1, filename: 'style.md', title: 'House style',
      source: 'project-promotion', source_project_id: 10, created_by: 2,
    });
    expect(queueIngest).toHaveBeenCalledWith(1, doc.id);

    const audit = querySync("SELECT * FROM auth_events WHERE type = 'promotion.approved'").rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: 1, org_id: 1 });
    expect(JSON.parse(audit[0].meta)).toMatchObject({
      requestId: request.id, projectId: 10, path: 'guidance/style.md', orgDocumentId: doc.id,
    });
  });

  it('reject records who and why, touches no files, and re-suggest opens a new row', async () => {
    const request = await suggest('later.md');
    as(1);
    const res = await decide(1, request.id, 'reject', { note: 'not yet' });
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({
      status: 'rejected', decided_by: 1, decision_note: 'not yet', org_document_id: null,
    });
    expect(count('org_documents')).toBe(0);
    expect(queueIngest).not.toHaveBeenCalled();
    expect(querySync("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'promotion.rejected'").rows[0].n).toBe(1);

    // Rejection is not a tombstone: the same path can be suggested again.
    as(2);
    const again = await promote(10, { path: 'later.md' });
    expect(again.status).toBe(202);
    expect((await again.json()).request.id).not.toBe(request.id);
    expect(count('promotion_requests')).toBe(2);
  });

  it('409s approve when the file is gone and reverts the row to pending (manual reject stays possible)', async () => {
    const request = await suggest('gone.md');
    await deleteProjectEntry(10, 'gone.md');
    as(1);
    const res = await decide(1, request.id, 'approve');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'file no longer exists at that path', code: 'not_found' });

    const row = querySync('SELECT * FROM promotion_requests WHERE id = $1', [request.id]).rows[0];
    expect(row).toMatchObject({
      status: 'pending', decided_by: null, decided_at: null, decision_note: null,
    });
    expect(count('org_documents')).toBe(0);
    expect(queueIngest).not.toHaveBeenCalled();

    // The queue keeps the request: rejecting it afterwards still works.
    expect((await decide(1, request.id, 'reject', { note: 'file was deleted' })).status).toBe(200);
  });

  it('MA3: a decided row cannot be decided again — no document is ever created for the loser', async () => {
    const request = await suggest('raced.md');
    // The other owner's reject landed first (claim already consumed).
    querySync(
      `UPDATE promotion_requests
       SET status = 'rejected', decided_by = 1,
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1`,
      [request.id],
    );
    as(1);
    const res = await decide(1, request.id, 'approve');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'request already decided' });
    // The losing approve did NOT copy: rejected content never reaches storage.
    expect(count('org_documents')).toBe(0);
    expect(queueIngest).not.toHaveBeenCalled();
    expect(querySync('SELECT status FROM promotion_requests WHERE id = $1', [request.id]).rows[0].status)
      .toBe('rejected');
  });

  it('403s editors on decide endpoints — including the suggester on their own request', async () => {
    const request = await suggest('mine.md');
    as(2); // the suggester themself
    for (const verb of ['approve', 'reject']) {
      const res = await decide(1, request.id, verb);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'requires owner role' });
    }
    expect(querySync('SELECT status FROM promotion_requests WHERE id = $1', [request.id]).rows[0].status)
      .toBe('pending');
  });

  it('404s unknown and cross-org request ids without leaking', async () => {
    const request = await suggest('cross.md');
    as(1);
    const missing = await decide(1, 999, 'approve');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'promotion request not found' });

    as(4); // owner of org 2 — org 1's request must not be reachable via org 2
    const cross = await decide(2, request.id, 'approve');
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({ error: 'promotion request not found' });
    expect(querySync('SELECT status FROM promotion_requests WHERE id = $1', [request.id]).rows[0].status)
      .toBe('pending');

    as(1); // org-1 owner is a stranger to org 2's queue
    expect((await fetch(`${base}/api/orgs/2/promotions`)).status).toBe(404);
  });

  it('publishes the decision on the project feed', async () => {
    const request = await suggest('feed.md');
    const events = [];
    const unsubscribe = subscribeProjectEvents(10, (e) => events.push(e));
    try {
      as(1);
      await decide(1, request.id, 'approve', { note: 'in it goes' });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'promotion', requestId: request.id, path: 'feed.md',
        status: 'approved', decidedBy: 1, note: 'in it goes',
      }));
    } finally {
      unsubscribe();
    }
  });

  it('403s the whole queue once the org is suspended', async () => {
    const request = await suggest('frozen.md');
    querySync("UPDATE organizations SET status = 'suspended' WHERE id = 1");
    as(1);
    for (const go of [
      fetch(`${base}/api/orgs/1/promotions`),
      decide(1, request.id, 'approve'),
      decide(1, request.id, 'reject'),
    ]) {
      const res = await go;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'organization suspended' });
    }
  });
});
