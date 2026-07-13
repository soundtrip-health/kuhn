import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';

// Real in-memory SQLite + real (temp) storage roots: this story is the
// tenancy boundary for org content, so containment and scoping run against
// the actual SQL and filesystem, not mocks.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let orgLibraryRouter; let projectsRouter;
let writeProjectFile; let resolveOrgSafe;
let server; let base;
let orgsRoot; let projectsRoot;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-orgs-'));
  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-proj-'));
  config.storage.orgsRoot = orgsRoot;
  config.agent.projectsRoot = projectsRoot;

  ({ default: orgLibraryRouter } = await import('./org-library.js'));
  ({ default: projectsRouter } = await import('./projects.js'));
  ({ writeProjectFile, resolveOrgSafe } = await import('../storage.js'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(orgLibraryRouter);
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
  querySync('DELETE FROM org_documents');
  querySync('DELETE FROM projects');
  querySync('DELETE FROM memberships');
  querySync('DELETE FROM users');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Mine', 'mine'), (2, 'Theirs', 'theirs')");
  querySync("INSERT INTO users (id, email, display_name) VALUES (1, 'dev@kuhn.local', 'Dev')");
  querySync("INSERT INTO memberships (user_id, org_id, role) VALUES (1, 1, 'owner')");
  querySync("INSERT INTO projects (id, org_id, name, project_type) VALUES (10, 1, 'P', 'manuscript')");
});

const upload = async (orgId, entries) => {
  const form = new FormData();
  for (const [name, content] of entries) {
    form.append('files', new Blob([content], { type: 'text/plain' }), name);
  }
  return fetch(`${base}/api/orgs/${orgId}/library/upload`, { method: 'POST', body: form });
};

describe('org library routes (story 006-001)', () => {
  it('uploads, lists, and serves a document; bytes land under the org root', async () => {
    const res = await upload(1, [['sop.txt', 'wash your hands']]);
    expect(res.status).toBe(201);
    const { documents } = await res.json();
    expect(documents[0]).toMatchObject({
      org_id: 1, filename: 'sop.txt', status: 'pending', source: 'upload',
      created_by: 1, deduped: false,
    });
    const doc = documents[0];

    const onDisk = join(orgsRoot, '1', 'library', String(doc.id), 'sop.txt');
    expect((await stat(onDisk)).size).toBe('wash your hands'.length);

    const list = await (await fetch(`${base}/api/orgs/1/library`)).json();
    expect(list.documents).toHaveLength(1);

    const content = await fetch(`${base}/api/orgs/1/library/${doc.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('wash your hands');
  });

  it('dedupes identical bytes onto the existing document', async () => {
    const first = (await (await upload(1, [['a.txt', 'same bytes']])).json()).documents[0];
    const second = (await (await upload(1, [['b.txt', 'same bytes']])).json()).documents[0];
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(querySync('SELECT COUNT(*) AS n FROM org_documents').rows[0].n).toBe(1);
  });

  it('404s every route for a non-member org without leaking', async () => {
    expect((await fetch(`${base}/api/orgs/2/library`)).status).toBe(404);
    expect((await upload(2, [['x.txt', 'x']])).status).toBe(404);
    expect((await fetch(`${base}/api/orgs/2/library/1/content`)).status).toBe(404);
    expect((await fetch(`${base}/api/orgs/2/library/1`, { method: 'DELETE' })).status).toBe(404);
  });

  it('stores a traversal filename as its base name only', async () => {
    const res = await upload(1, [['../../evil.txt', 'contained']]);
    const { documents } = await res.json();
    expect(documents[0].filename).toBe('evil.txt');
    const docDir = join(orgsRoot, '1', 'library', String(documents[0].id));
    expect(await readdir(docDir)).toEqual(['evil.txt']);
  });

  it('deletes record and bytes together', async () => {
    const doc = (await (await upload(1, [['gone.txt', 'bye']])).json()).documents[0];
    const res = await fetch(`${base}/api/orgs/1/library/${doc.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(querySync('SELECT COUNT(*) AS n FROM org_documents').rows[0].n).toBe(0);
    await expect(stat(join(orgsRoot, '1', 'library', String(doc.id)))).rejects.toThrow();
  });

  it('promotes a project file into the owning org library', async () => {
    await writeProjectFile(10, 'guidance/style.md', '# House style');
    const res = await fetch(`${base}/api/projects/10/files/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'guidance/style.md', title: 'House style' }),
    });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toMatchObject({
      org_id: 1, filename: 'style.md', title: 'House style',
      source: 'project-promotion', source_project_id: 10,
    });

    // Promoting the same bytes again dedupes.
    const again = await fetch(`${base}/api/projects/10/files/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'guidance/style.md' }),
    });
    expect(again.status).toBe(200);
    expect((await again.json()).deduped).toBe(true);

    // Missing file → readable 404.
    const missing = await fetch(`${base}/api/projects/10/files/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'nope.md' }),
    });
    expect(missing.status).toBe(404);
  });

  it('blocks deleting an org that still has library documents (FK RESTRICT)', async () => {
    await upload(1, [['keep.txt', 'held']]);
    expect(() => querySync('DELETE FROM organizations WHERE id = 1')).toThrow();
  });

  it('org storage scope rejects escapes like the project scope does', async () => {
    await expect(resolveOrgSafe(1, '../2/steal.txt')).rejects.toMatchObject({ code: 'outside_root' });
    await expect(resolveOrgSafe(1, '/etc/hosts')).rejects.toMatchObject({ code: 'outside_root' });
    await expect(resolveOrgSafe(99, 'x.txt')).rejects.toMatchObject({ code: 'not_found' });
  });
});
