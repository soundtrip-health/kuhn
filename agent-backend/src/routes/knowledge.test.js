// Issue #65 (PLA-255): knowledge selection/import behavior. Tenancy sweeps for
// these routes live in tenancy-matrix.test.js; this suite proves the
// mechanics: enable → import → linked org document, idempotent re-enable,
// disable removes document + chunks, version bump → update_available →
// reimport, dedupe stamping, validation refusals, audit rows. Real SQLite +
// real storage in temp dirs; ingestion mocked (006-002 has its own tests).

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../ingest.js', () => ({ queueIngest: vi.fn() }));

const ORG = 1;
const STYLE = 'writing/style';
const ABSENT = 'writing/absent';

let config; let exec; let querySync;
let server; let base; let cookies = {};
let catalogRoot; let orgsRoot; let saved;
let queueIngest; let storeOrgDocument;

function call(method, path, principal = 'owner', json) {
  const headers = { Cookie: `kuhn_session=${encodeURIComponent(cookies[principal])}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return fetch(new URL(path, base), { method, headers, body });
}

const item = (packages, id) =>
  packages.flatMap((p) => p.items).find((i) => i.id === id);
const importedDoc = (itemId) => querySync(
  'SELECT * FROM org_documents WHERE org_id = $1 AND catalog_item_id = $2',
  [ORG, itemId],
).rows[0] ?? null;
const selections = () => querySync(
  'SELECT item_id FROM org_knowledge_selections WHERE org_id = $1', [ORG],
).rows.map((r) => r.item_id);

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  saved = {
    mode: config.auth.mode,
    secret: config.auth.sessionSecret,
    orgsRoot: config.storage.orgsRoot,
    catalogRoot: config.knowledge.catalogRoot,
  };
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-knowledge-orgs-'));
  catalogRoot = await mkdtemp(join(tmpdir(), 'kuhn-knowledge-catalog-'));
  config.storage.orgsRoot = orgsRoot;
  config.knowledge.catalogRoot = catalogRoot;

  await mkdir(join(catalogRoot, 'writing'), { recursive: true });
  await writeFile(join(catalogRoot, 'writing', 'style.md'), '# Style guide\n\nWrite plainly.\n');
  await writeFile(join(catalogRoot, 'catalog.json'), JSON.stringify({
    catalog_version: 1,
    packages: [{
      id: 'writing',
      title: 'Writing',
      parent: null,
      items: [
        { id: STYLE, title: 'Style', path: 'writing/style.md', version: 1, kind: 'document' },
        { id: ABSENT, title: 'Absent', path: 'writing/absent.md', version: 1, kind: 'document' },
      ],
    }],
  }));

  ({ exec, querySync } = await import('../db.js'));
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf-8'));
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org', 'org')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@test'), (2, 'viewer@test')");
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (1, ${ORG}, 'owner'), (2, ${ORG}, 'viewer')`);

  const { seedKnowledgeCatalog } = await import('../db/seed.js');
  await seedKnowledgeCatalog();

  ({ queueIngest } = await import('../ingest.js'));
  ({ storeOrgDocument } = await import('./org-library.js'));

  const { createSession } = await import('../db/auth.js');
  cookies.owner = (await createSession(1)).cookieValue;
  cookies.viewer = (await createSession(2)).cookieValue;

  const { session } = await import('../session.js');
  const app = express();
  app.use(express.json());
  app.use(session);
  app.use((await import('./knowledge.js')).default);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = saved.mode;
  config.auth.sessionSecret = saved.secret;
  config.storage.orgsRoot = saved.orgsRoot;
  config.knowledge.catalogRoot = saved.catalogRoot;
  await new Promise((ok) => server.close(ok));
  await rm(orgsRoot, { recursive: true, force: true });
  await rm(catalogRoot, { recursive: true, force: true });
});

describe('catalog views', () => {
  it('GET /api/knowledge/catalog returns the seeded tree without org state', async () => {
    const res = await call('GET', '/api/knowledge/catalog', 'viewer');
    expect(res.status).toBe(200);
    const { packages } = await res.json();
    expect(packages).toMatchObject([{ id: 'writing', parent: null, available: true }]);
    expect(item(packages, STYLE)).toMatchObject({ available: true, version: 1, tags: [] });
    expect(item(packages, STYLE).enabled).toBeUndefined();
    expect(item(packages, ABSENT)).toMatchObject({ available: false });
  });

  it('GET /api/orgs/:orgId/knowledge merges org state (nothing enabled yet)', async () => {
    const res = await call('GET', `/api/orgs/${ORG}/knowledge`, 'viewer');
    expect(res.status).toBe(200);
    const { packages } = await res.json();
    expect(item(packages, STYLE)).toMatchObject({
      enabled: false, doc_id: null, doc_status: null,
      imported_version: null, update_available: false,
    });
  });
});

describe('enable → import → disable', () => {
  it('enabling records the selection and imports the content', async () => {
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);

    const doc = importedDoc(STYLE);
    expect(doc).toMatchObject({
      source: 'guidance-import', catalog_item_id: STYLE, catalog_item_version: 1,
      filename: 'style.md', title: 'Style', created_by: 1, status: 'pending',
    });
    expect(selections()).toEqual([STYLE]);
    expect(queueIngest).toHaveBeenCalledWith(ORG, doc.id);
    await stat(join(orgsRoot, String(ORG), 'library', String(doc.id), 'style.md'));

    const { packages } = await res.json();
    expect(item(packages, STYLE)).toMatchObject({
      enabled: true, doc_id: doc.id, doc_status: 'pending',
      imported_version: 1, update_available: false,
    });
    expect(querySync(
      "SELECT org_id, actor_user_id, meta FROM auth_events WHERE type = 'knowledge.enable'",
    ).rows).toMatchObject([{ org_id: ORG, actor_user_id: 1, meta: JSON.stringify({ items: [STYLE] }) }]);
  });

  it('re-enabling is idempotent: one selection, one document, no re-import', async () => {
    const before = importedDoc(STYLE).id;
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    expect(selections()).toEqual([STYLE]);
    expect(importedDoc(STYLE).id).toBe(before);
    expect(querySync(
      `SELECT COUNT(*) AS n FROM org_documents WHERE org_id = ${ORG}`,
    ).rows[0].n).toBe(1);
  });

  it('a catalog version bump surfaces update_available; reimport clears it', async () => {
    querySync(`UPDATE knowledge_items SET version = 2 WHERE id = '${STYLE}'`);
    let { packages } = await (await call('GET', `/api/orgs/${ORG}/knowledge`, 'viewer')).json();
    expect(item(packages, STYLE)).toMatchObject({ imported_version: 1, update_available: true });

    const oldDocId = importedDoc(STYLE).id;
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    expect(res.status).toBe(200);
    ({ packages } = await res.json());
    const doc = importedDoc(STYLE);
    expect(doc.id).not.toBe(oldDocId);
    expect(doc.catalog_item_version).toBe(2);
    expect(item(packages, STYLE)).toMatchObject({ imported_version: 2, update_available: false });
  });

  it('disabling removes the selection, the document, its chunks, and its bytes', async () => {
    const doc = importedDoc(STYLE);
    querySync(
      'INSERT INTO org_document_chunks (doc_id, seq, text) VALUES ($1, 0, $2)',
      [doc.id, 'Write plainly.'],
    );
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { disable: [STYLE] });
    expect(res.status).toBe(200);

    expect(selections()).toEqual([]);
    expect(importedDoc(STYLE)).toBeNull();
    expect(querySync(
      'SELECT COUNT(*) AS n FROM org_document_chunks WHERE doc_id = $1', [doc.id],
    ).rows[0].n).toBe(0);
    await expect(stat(join(orgsRoot, String(ORG), 'library', String(doc.id))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const { packages } = await res.json();
    expect(item(packages, STYLE)).toMatchObject({ enabled: false, doc_id: null });
    expect(querySync(
      "SELECT meta FROM auth_events WHERE type = 'knowledge.disable'",
    ).rows).toMatchObject([{ meta: JSON.stringify({ items: [STYLE] }) }]);
  });

  it('enabling an item whose bytes already exist as an upload stamps the catalog link', async () => {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(join(catalogRoot, 'writing', 'style.md'));
    const { document } = await storeOrgDocument(ORG, bytes, { filename: 'my-copy.md' });
    expect(document.catalog_item_id).toBeNull();

    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    expect(importedDoc(STYLE)).toMatchObject({ id: document.id, catalog_item_version: 2 });

    // Cleanup for any later cases.
    await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner', { disable: [STYLE] });
  });
});

describe('validation refusals (post-guard)', () => {
  it.each([
    ['unknown enable id', 'PUT', 'selections', { enable: ['nope/nope'] }, 400],
    ['unknown disable id', 'PUT', 'selections', { disable: ['nope/nope'] }, 400],
    ['non-array enable', 'PUT', 'selections', { enable: 'writing/style' }, 400],
    ['unavailable item enable', 'PUT', 'selections', { enable: [ABSENT] }, 409],
    ['same item both ways', 'PUT', 'selections', { enable: [STYLE], disable: [STYLE] }, 400],
    ['unknown reimport id', 'POST', 'reimport', { items: ['nope/nope'] }, 400],
    ['reimport of a disabled item', 'POST', 'reimport', { items: [STYLE] }, 409],
  ])('%s → %i', async (_label, method, tail, body, status) => {
    const res = await call(method, `/api/orgs/${ORG}/knowledge/${tail}`, 'owner', body);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBeTruthy();
    // Refusals are all-or-nothing: no partial state was written.
    expect(selections()).toEqual([]);
  });
});
