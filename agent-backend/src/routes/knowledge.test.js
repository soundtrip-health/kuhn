// Issue #65 (PLA-255): knowledge selection/import behavior. Tenancy sweeps for
// these routes live in tenancy-matrix.test.js; this suite proves the
// mechanics: enable → import → linked org document, idempotent re-enable,
// disable removes document + chunks, version bump → update_available →
// reimport, dedupe stamping, validation refusals, audit rows. Real SQLite +
// real storage in temp dirs; ingestion mocked (006-002 has its own tests).

import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../ingest.js', () => ({ queueIngest: vi.fn() }));

const ORG = 1;
const STYLE = 'writing/style';
const ABSENT = 'writing/absent';
const EXTRA = 'writing/extra';
const TWIN = 'writing/twin'; // distinct item whose content can mirror STYLE's

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
  await writeFile(join(catalogRoot, 'writing', 'extra.md'), '# Extra\n\nMore guidance.\n');
  await writeFile(join(catalogRoot, 'writing', 'twin.md'), '# Twin\n\nRewritten by its suite.\n');
  await writeFile(join(catalogRoot, 'catalog.json'), JSON.stringify({
    catalog_version: 1,
    packages: [{
      id: 'writing',
      title: 'Writing',
      parent: null,
      items: [
        { id: STYLE, title: 'Style', path: 'writing/style.md', version: 1, kind: 'document' },
        { id: ABSENT, title: 'Absent', path: 'writing/absent.md', version: 1, kind: 'document' },
        { id: EXTRA, title: 'Extra', path: 'writing/extra.md', version: 1, kind: 'knowledge-card' },
        { id: TWIN, title: 'Twin', path: 'writing/twin.md', version: 1, kind: 'document' },
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
  app.use((await import('./org-library.js')).default);
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

  it('a malformed tags value in the DB degrades to [], not a 500', async () => {
    const before = querySync(
      'SELECT tags FROM knowledge_items WHERE id = $1', [EXTRA]).rows[0].tags;
    querySync('UPDATE knowledge_items SET tags = $2 WHERE id = $1', [EXTRA, '{not json']);
    const res = await call('GET', '/api/knowledge/catalog', 'viewer');
    querySync('UPDATE knowledge_items SET tags = $2 WHERE id = $1', [EXTRA, before]);
    expect(res.status).toBe(200);
    const { packages } = await res.json();
    expect(item(packages, EXTRA).tags).toEqual([]);
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

    // The catalog content is unchanged, only the version label moved — the
    // reimport recognizes identical bytes and restamps the existing document
    // instead of destroying and recreating it.
    const oldDocId = importedDoc(STYLE).id;
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    expect(res.status).toBe(200);
    ({ packages } = await res.json());
    const doc = importedDoc(STYLE);
    expect(doc.id).toBe(oldDocId);
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

  it('a deduped upload is adopted on enable and unlinked — never deleted — on disable (PLA-255 §1)', async () => {
    // A user uploads bytes identical to the catalog item, before any catalog
    // involvement. Remember everything about it.
    const bytes = await readFile(join(catalogRoot, 'writing', 'style.md'));
    const { document } = await storeOrgDocument(ORG, bytes, { filename: 'my-copy.md' });
    expect(document.catalog_item_id).toBeNull();
    expect(document.source).toBe('upload');
    querySync('INSERT INTO org_document_chunks (doc_id, seq, text) VALUES ($1, 0, $2)',
      [document.id, 'Write plainly.']);

    // Enabling the catalog item adopts the upload via (org, sha256) dedupe.
    let res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    expect(importedDoc(STYLE)).toMatchObject(
      { id: document.id, source: 'upload', catalog_item_version: 2 });

    // Disabling removes only the catalog association. The user's document —
    // row, source, bytes, chunks — survives untouched.
    res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner', { disable: [STYLE] });
    expect(res.status).toBe(200);
    const survivor = querySync(
      'SELECT * FROM org_documents WHERE org_id = $1 AND id = $2', [ORG, document.id]).rows[0];
    expect(survivor).toMatchObject({
      source: 'upload', filename: 'my-copy.md', sha256: document.sha256,
      catalog_item_id: null, catalog_item_version: null,
    });
    await stat(join(orgsRoot, String(ORG), 'library', String(document.id), 'my-copy.md'));
    expect(querySync(
      'SELECT COUNT(*) AS n FROM org_document_chunks WHERE doc_id = $1', [document.id],
    ).rows[0].n).toBe(1);
    expect(selections()).toEqual([]);
    expect(importedDoc(STYLE)).toBeNull();

    // Remove the upload so later suites exercise fresh catalog-owned imports.
    querySync('DELETE FROM org_documents WHERE org_id = $1 AND id = $2', [ORG, document.id]);
  });

  it('a deduped project promotion survives disable the same way (PLA-255 §1)', async () => {
    const bytes = await readFile(join(catalogRoot, 'writing', 'extra.md'));
    const { document } = await storeOrgDocument(ORG, bytes,
      { filename: 'promoted.md', source: 'project-promotion' });
    expect(document.source).toBe('project-promotion');

    let res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [EXTRA] });
    expect(res.status).toBe(200);
    expect(importedDoc(EXTRA)).toMatchObject({ id: document.id, source: 'project-promotion' });

    res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner', { disable: [EXTRA] });
    expect(res.status).toBe(200);
    expect(querySync(
      'SELECT * FROM org_documents WHERE org_id = $1 AND id = $2', [ORG, document.id]).rows[0])
      .toMatchObject({ source: 'project-promotion', catalog_item_id: null });
    await stat(join(orgsRoot, String(ORG), 'library', String(document.id), 'promoted.md'));
    expect(importedDoc(EXTRA)).toBeNull();

    querySync('DELETE FROM org_documents WHERE org_id = $1 AND id = $2', [ORG, document.id]);
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

describe('reimport preserves the last good import (PLA-255 §2)', () => {
  const stylePath = () => join(catalogRoot, 'writing', 'style.md');
  const docDir = (id) => join(orgsRoot, String(ORG), 'library', String(id));
  let original; // the catalog-owned import every failure case must preserve

  it('setup: enable creates a fresh catalog-owned import', async () => {
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    original = importedDoc(STYLE);
    expect(original).toMatchObject({ source: 'guidance-import', catalog_item_version: 2 });
    await stat(join(docDir(original.id), 'style.md'));
  });

  it('missing replacement file → 502, previous import intact', async () => {
    await rename(stylePath(), `${stylePath()}.bak`);
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    await rename(`${stylePath()}.bak`, stylePath());
    expect(res.status).toBe(502);
    expect(importedDoc(STYLE)).toMatchObject({ id: original.id, sha256: original.sha256 });
    await stat(join(docDir(original.id), 'style.md'));
    expect(selections()).toEqual([STYLE]);
  });

  it('containment failure (escaping symlink) → 502, previous import intact', async () => {
    const outside = join(tmpdir(), 'kuhn-knowledge-outside.md');
    await writeFile(outside, 'bytes outside the catalog root');
    await symlink(outside, join(catalogRoot, 'writing', 'escape.md'));
    querySync("UPDATE knowledge_items SET path = 'writing/escape.md' WHERE id = $1", [STYLE]);
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    querySync("UPDATE knowledge_items SET path = 'writing/style.md' WHERE id = $1", [STYLE]);
    await rm(outside, { force: true });
    expect(res.status).toBe(502);
    expect(importedDoc(STYLE)).toMatchObject({ id: original.id, sha256: original.sha256 });
    await stat(join(docDir(original.id), 'style.md'));
  });

  it('storage write failure on changed bytes → 502, previous import intact, no orphan row', async () => {
    await writeFile(stylePath(), '# Style guide v3\n\nDifferent bytes this time.\n');
    const savedMax = config.storage.maxFileBytes;
    config.storage.maxFileBytes = 4; // replacement write must fail
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    config.storage.maxFileBytes = savedMax;
    expect(res.status).toBe(502);
    expect(importedDoc(STYLE)).toMatchObject({ id: original.id, sha256: original.sha256 });
    await stat(join(docDir(original.id), 'style.md'));
    expect(querySync(
      `SELECT COUNT(*) AS n FROM org_documents WHERE org_id = ${ORG}`,
    ).rows[0].n).toBe(1);
    // Back to the original bytes for the identical-bytes case below.
    await writeFile(stylePath(), '# Style guide\n\nWrite plainly.\n');
  });

  it('identical bytes: reimport restamps the version, keeping the same document', async () => {
    querySync('UPDATE knowledge_items SET version = 3 WHERE id = $1', [STYLE]);
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    expect(res.status).toBe(200);
    expect(importedDoc(STYLE)).toMatchObject(
      { id: original.id, sha256: original.sha256, catalog_item_version: 3 });
    expect(querySync(
      `SELECT COUNT(*) AS n FROM org_documents WHERE org_id = ${ORG}`,
    ).rows[0].n).toBe(1);
    // Two successful reimports so far (the version-bump case above and this
    // one); the three failed attempts in between audited nothing.
    const audited = querySync(
      "SELECT meta FROM auth_events WHERE type = 'knowledge.reimport'").rows;
    expect(audited).toHaveLength(2);
    expect(audited.every((r) => r.meta === JSON.stringify({ items: [STYLE] }))).toBe(true);
  });

  it('changed bytes: replacement is stored before the old catalog-owned copy is removed', async () => {
    await writeFile(stylePath(), '# Style guide v4\n\nGenuinely new content.\n');
    const res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
      { items: [STYLE] });
    expect(res.status).toBe(200);
    const doc = importedDoc(STYLE);
    expect(doc.id).not.toBe(original.id);
    expect(doc.sha256).not.toBe(original.sha256);
    expect(doc).toMatchObject({ source: 'guidance-import', catalog_item_version: 3 });
    await stat(join(docDir(doc.id), 'style.md'));
    // The old catalog-owned copy is gone — row and bytes.
    expect(querySync(
      `SELECT COUNT(*) AS n FROM org_documents WHERE org_id = ${ORG}`,
    ).rows[0].n).toBe(1);
    await expect(stat(docDir(original.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an adopted upload is unlinked, not deleted, by a changed-bytes reimport', async () => {
    // Turn the current import into an adopted upload: disable (removes the
    // catalog-owned copy), upload identical bytes, re-enable (adopts).
    await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner', { disable: [STYLE] });
    const bytes = await readFile(stylePath());
    const { document: mine } = await storeOrgDocument(ORG, bytes, { filename: 'adopted.md' });
    let res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    expect(importedDoc(STYLE)).toMatchObject({ id: mine.id, source: 'upload' });

    await writeFile(stylePath(), '# Style guide v5\n\nNewer still.\n');
    res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner', { items: [STYLE] });
    expect(res.status).toBe(200);
    const doc = importedDoc(STYLE);
    expect(doc.id).not.toBe(mine.id);
    expect(doc.source).toBe('guidance-import');
    // The user's upload survives, merely unlinked.
    expect(querySync(
      'SELECT * FROM org_documents WHERE org_id = $1 AND id = $2', [ORG, mine.id]).rows[0])
      .toMatchObject({ source: 'upload', catalog_item_id: null, catalog_item_version: null });
    await stat(join(docDir(mine.id), 'adopted.md'));
  });
});

describe('batch failure semantics (PLA-255 §6)', () => {
  const extraPath = () => join(catalogRoot, 'writing', 'extra.md');

  it('a failed enable records no selection and no audit row', async () => {
    // EXTRA is available per the catalog rows, but its file vanishes on disk.
    await rename(extraPath(), `${extraPath()}.bak`);
    const before = querySync(
      "SELECT COUNT(*) AS n FROM auth_events WHERE type = 'knowledge.enable'").rows[0].n;
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [EXTRA] });
    await rename(`${extraPath()}.bak`, extraPath());
    expect(res.status).toBe(502);
    expect(selections()).not.toContain(EXTRA); // no half-written selection
    expect(importedDoc(EXTRA)).toBeNull();
    expect(querySync(
      "SELECT COUNT(*) AS n FROM auth_events WHERE type = 'knowledge.enable'").rows[0].n)
      .toBe(before);
  });

  it('a mixed batch stops at the failure and audits exactly what happened', async () => {
    // STYLE is enabled from the previous suite; EXTRA's file goes missing.
    await rename(extraPath(), `${extraPath()}.bak`);
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { disable: [STYLE], enable: [EXTRA] });
    await rename(`${extraPath()}.bak`, extraPath());
    expect(res.status).toBe(502);
    // The disable half really happened and is audited…
    expect(selections()).toEqual([]);
    expect(querySync(
      "SELECT meta FROM auth_events WHERE type = 'knowledge.disable' ORDER BY id DESC LIMIT 1",
    ).rows[0].meta).toBe(JSON.stringify({ items: [STYLE] }));
    // …the enable half cleanly did not.
    expect(importedDoc(EXTRA)).toBeNull();
  });
});

describe('catalog-linked documents refuse the ordinary library delete', () => {
  it('DELETE /library/:docId → 409 while linked; disabling remains the way out', async () => {
    let res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    const doc = importedDoc(STYLE);

    res = await call('DELETE', `/api/orgs/${ORG}/library/${doc.id}`, 'owner');
    expect(res.status).toBe(409);
    expect(importedDoc(STYLE)).toMatchObject({ id: doc.id });

    res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { disable: [STYLE] });
    expect(res.status).toBe(200);
    expect(importedDoc(STYLE)).toBeNull();
  });
});

describe('two catalog items with identical bytes (PLA-255 merge blocker)', () => {
  // One org_documents row carries one catalog link, so a second item whose
  // bytes dedupe onto another item's document must be refused outright —
  // never enabled-but-unbacked, never stealing the first item's link.
  const enableAudits = () => querySync(
    "SELECT meta FROM auth_events WHERE type = 'knowledge.enable'").rows;
  let docA;

  it('enabling the first item succeeds and links its document', async () => {
    const shared = '# Shared\n\nIdentical bytes served by two catalog items.\n';
    await writeFile(join(catalogRoot, 'writing', 'style.md'), shared);
    await writeFile(join(catalogRoot, 'writing', 'twin.md'), shared);

    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    docA = importedDoc(STYLE);
    expect(docA).toMatchObject({ source: 'guidance-import', catalog_item_id: STYLE });
    expect(selections()).toEqual([STYLE]);
  });

  it('enabling the second item refuses with a conflict, leaving the first untouched', async () => {
    const auditsBefore = enableAudits().length;
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [TWIN] });
    expect(res.status).toBe(409);
    expect((await res.json()).error)
      .toBe(`knowledge import refused: content of ${TWIN} is identical to the `
        + `already-enabled ${STYLE}; disable that item first`);

    // No selection row, no document link, no audit row for the refused item.
    expect(selections()).toEqual([STYLE]);
    expect(importedDoc(TWIN)).toBeNull();
    expect(enableAudits().length).toBe(auditsBefore);
    expect(enableAudits().some((r) => r.meta.includes(TWIN))).toBe(false);

    // The first item's import is byte-for-byte unchanged and still linked.
    expect(importedDoc(STYLE)).toMatchObject(
      { id: docA.id, sha256: docA.sha256, catalog_item_id: STYLE });

    const { packages } = await (await call('GET', `/api/orgs/${ORG}/knowledge`, 'viewer')).json();
    expect(item(packages, TWIN)).toMatchObject({ enabled: false, doc_id: null });
    expect(item(packages, STYLE)).toMatchObject({ enabled: true, doc_id: docA.id });
  });

  it('disabling the first item cleans up normally, with no residual second-item state', async () => {
    const res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { disable: [STYLE] });
    expect(res.status).toBe(200);
    expect(selections()).toEqual([]);
    expect(importedDoc(STYLE)).toBeNull();
    expect(importedDoc(TWIN)).toBeNull();
    await expect(stat(join(orgsRoot, String(ORG), 'library', String(docA.id))))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const { packages } = await (await call('GET', `/api/orgs/${ORG}/knowledge`, 'viewer')).json();
    expect(item(packages, TWIN)).toMatchObject({ enabled: false, doc_id: null });
    expect(item(packages, STYLE)).toMatchObject({ enabled: false, doc_id: null });
  });
});

describe('post-commit cleanup failure is non-fatal (review fix)', () => {
  // Once the link swap has committed the reimport IS live — a failure to
  // delete the replaced bytes afterwards must not turn the response into a
  // 502 or drop the item from the knowledge.reimport audit (a retry takes the
  // identical-bytes branch, so nothing would ever reattempt this delete).
  const stylePath = () => join(catalogRoot, 'writing', 'style.md');
  const docDir = (id) => join(orgsRoot, String(ORG), 'library', String(id));

  it('reimport still succeeds, audits, and serves the new import', async () => {
    await writeFile(stylePath(), '# Cleanup case\n\nOriginal import.\n');
    let res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { enable: [STYLE] });
    expect(res.status).toBe(200);
    const old = importedDoc(STYLE);
    expect(old).toMatchObject({ source: 'guidance-import' });

    await writeFile(stylePath(), '# Cleanup case v2\n\nReplacement bytes.\n');
    const auditsBefore = querySync(
      "SELECT COUNT(*) AS n FROM auth_events WHERE type = 'knowledge.reimport'").rows[0].n;
    // Strip write permission from the old copy's directory so the post-commit
    // deleteOrgEntry fails with a non-not_found error.
    await chmod(docDir(old.id), 0o555);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let loggedCleanupFailure = false;
    try {
      res = await call('POST', `/api/orgs/${ORG}/knowledge/reimport`, 'owner',
        { items: [STYLE] });
      loggedCleanupFailure = logged.mock.calls.length > 0;
    } finally {
      await chmod(docDir(old.id), 0o755);
      logged.mockRestore();
    }

    // The reimport reports success and the audit row was recorded.
    expect(res.status).toBe(200);
    expect(querySync(
      "SELECT COUNT(*) AS n FROM auth_events WHERE type = 'knowledge.reimport'").rows[0].n)
      .toBe(auditsBefore + 1);

    // The new import is live: linked row, new bytes on disk, old row gone.
    const doc = importedDoc(STYLE);
    expect(doc.id).not.toBe(old.id);
    expect(doc).toMatchObject({ source: 'guidance-import', catalog_item_id: STYLE });
    await stat(join(docDir(doc.id), 'style.md'));
    expect(querySync(
      'SELECT COUNT(*) AS n FROM org_documents WHERE org_id = $1 AND id = $2',
      [ORG, old.id],
    ).rows[0].n).toBe(0);
    const { packages } = await res.json();
    expect(item(packages, STYLE)).toMatchObject({ enabled: true, doc_id: doc.id });

    // The failure was real: the old directory leaked, and was logged.
    await stat(join(docDir(old.id), 'style.md'));
    expect(loggedCleanupFailure).toBe(true);

    // Tidy up the leak and the selection so reruns stay readable.
    await rm(docDir(old.id), { recursive: true, force: true });
    res = await call('PUT', `/api/orgs/${ORG}/knowledge/selections`, 'owner',
      { disable: [STYLE] });
    expect(res.status).toBe(200);
  });
});
