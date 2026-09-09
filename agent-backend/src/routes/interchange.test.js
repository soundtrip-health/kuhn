// Interchange import routes (issue #153) end to end: real in-memory SQLite,
// real storage in a temp dir, real git history, real tenancy guards. Only the
// collaboration server is mocked (to simulate a member holding a doc open)
// and the session middleware is a stand-in that reads x-test-user.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { strToU8, zipSync } from 'fflate';

process.env.KUHN_SQLITE_PATH = ':memory:';

const roomState = { memberConns: new Map() };
vi.mock('../yjs-websocket.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    memberConnectionCount: vi.fn((name) => roomState.memberConns.get(name) ?? 0),
    evictRoom: vi.fn(() => true),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../../test-projects/interchange');

let config; let exec; let querySync;
let comments; let getProject; let createProject; let writeProjectFile;
let evictRoom;
let server; let base; let root;
const USERS = {};

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  comments = await import('../db/comments.js');
  ({ getProject, createProject } = await import('../db/projects.js'));
  ({ writeProjectFile } = await import('../storage.js'));
  ({ evictRoom } = await import('../yjs-websocket.js'));
  root = await mkdtemp(join(tmpdir(), 'kuhn-interchange-'));
  config.agent.projectsRoot = root;

  const { default: interchangeRouter } = await import('./interchange.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const who = req.get('x-test-user') ?? 'editorA';
    req.user = USERS[who];
    if (!req.user) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    next();
  });
  app.use(interchangeRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  roomState.memberConns.clear();
  vi.mocked(evictRoom).mockClear();
  for (const t of ['comments', 'file_events', 'bib_references', 'projects', 'memberships', 'users', 'organizations']) {
    querySync(`DELETE FROM ${t}`);
  }
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'Org A', 'a'), (2, 'Org B', 'b')");
  const mk = (key, email, orgId, role) => {
    const { rows } = querySync('INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id, email, display_name, is_superadmin', [email, key]);
    USERS[key] = rows[0];
    querySync('INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)', [rows[0].id, orgId, role]);
  };
  mk('editorA', 'editor@a.org', 1, 'editor');
  mk('viewerA', 'viewer@a.org', 1, 'viewer');
  mk('ownerB', 'owner@b.org', 2, 'owner');
});

// ---- fixture → zip ---------------------------------------------------------

function readTree(dir, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) Object.assign(out, readTree(abs, rel));
    else if (rel !== 'README.md') out[rel] = new Uint8Array(readFileSync(abs));
  }
  return out;
}

const FIXTURE_ENTRIES = readTree(FIXTURE);
const fixtureManifest = () => JSON.parse(Buffer.from(FIXTURE_ENTRIES['manifest.json']).toString('utf-8'));
const fixtureRefs = () => JSON.parse(Buffer.from(FIXTURE_ENTRIES['references.json']).toString('utf-8'));
const fixtureDoc = () => Buffer.from(FIXTURE_ENTRIES['files/draft/main.md']).toString('utf-8');

/** The fixture bundle with overrides: strings/objects are encoded, null deletes. */
function bundle(over = {}) {
  const entries = { ...FIXTURE_ENTRIES };
  for (const [name, value] of Object.entries(over)) {
    if (value === null) delete entries[name];
    else if (typeof value === 'string') entries[name] = strToU8(value);
    else if (value instanceof Uint8Array) entries[name] = value;
    else entries[name] = strToU8(JSON.stringify(value));
  }
  return Buffer.from(zipSync(entries));
}

async function post(path, zip, { user = 'editorA', fields = {} } = {}) {
  const fd = new FormData();
  if (zip) fd.append('bundle', new Blob([zip], { type: 'application/zip' }), 'bundle.zip');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'x-test-user': user }, body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const create = (zip = bundle(), opts) => post('/api/projects/import', zip, opts);
const update = (id, zip = bundle(), opts) => post(`/api/projects/${id}/import`, zip, opts);
const readDoc = (id, path = 'draft/main.md') => readFile(join(root, String(id), path), 'utf-8');

// ---- tests -----------------------------------------------------------------

describe('POST /api/projects/import (create)', () => {
  it('creates the project in the caller\'s org and lands docs, assets, references and a checkpoint', async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body.project).toMatchObject({ name: 'bendable2 — for review', project_type: 'manuscript', org_id: 1 });
    expect(body.files).toEqual([
      { path: 'draft/main.md', kind: 'doc', created: true },
      { path: 'draft/figures/fig1.png', kind: 'asset', created: true },
    ]);
    expect(body.references).toEqual([
      { cite_key: 'Berman2000', status: 'created', actual_key: 'Berman2000' },
      { cite_key: 'Zarate2006', status: 'created', actual_key: 'Zarate2006' },
    ]);
    expect(body.citations_rewritten).toEqual({});
    expect(body.comments).toEqual({ reanchored: 0, orphaned: 0 });
    expect(body.checkpoint).toMatch(/^[0-9a-f]{40}$/);

    const id = body.project.id;
    expect(await readDoc(id)).toBe(fixtureDoc());
    expect((await readFile(join(root, String(id), 'draft/figures/fig1.png'))).length).toBeGreaterThan(0);
    const bib = await readFile(join(root, String(id), 'draft/references.bib'), 'utf-8');
    expect(bib).toContain('@article{Berman2000,');
    expect(bib).toContain('@article{Zarate2006,');
    expect(bib).toContain('Zarate, C. A. and Singh, J. B.'); // object authors normalized

    // Provenance + activity rows.
    const project = await getProject(id);
    expect(project.config.interchange).toMatchObject({
      source: { tool: 'sciwriter', project: 'bendable2' },
      checkpoint: body.checkpoint,
      imported_by: USERS.editorA.id,
    });
    expect(project.config.interchange.docs['draft/main.md']).toMatchObject({
      title: 'Ketamine for treatment-resistant depression',
      meta: { figure_numbering: { 'fig:forest': 1 } },
    });
    const events = querySync('SELECT path, kind, user_id FROM file_events WHERE project_id = $1 ORDER BY id', [id]).rows;
    expect(events).toEqual([
      { path: 'draft/main.md', kind: 'create', user_id: USERS.editorA.id },
      { path: 'draft/figures/fig1.png', kind: 'create', user_id: USERS.editorA.id },
    ]);
  });

  it('honors manifest.project.org_id when the caller is an editor there, and refuses otherwise', async () => {
    const m = fixtureManifest();
    m.project.org_id = 2;
    expect((await create(bundle({ 'manifest.json': m }), { user: 'ownerB' })).body.project.org_id).toBe(2);
    expect((await create(bundle({ 'manifest.json': m }))).status).toBe(404); // not a member of B → non-leaking
    expect((await create(bundle(), { user: 'viewerA' })).status).toBe(403); // viewer cannot create
    expect(querySync('SELECT COUNT(*) AS n FROM projects').rows[0].n).toBe(1);
  });

  it('an invalid bundle creates nothing', async () => {
    const m = fixtureManifest();
    delete m.project.name;
    expect((await create(bundle({ 'manifest.json': m }))).body).toMatchObject({ code: 'invalid_bundle', error: /project.name/ });
    expect((await create(bundle({ 'files/draft/main.md': null }))).status).toBe(400);
    expect((await create(Buffer.from('nope'))).status).toBe(400);
    expect((await post('/api/projects/import', null)).status).toBe(400);
    expect(querySync('SELECT COUNT(*) AS n FROM projects').rows[0].n).toBe(0);
    expect(querySync('SELECT COUNT(*) AS n FROM bib_references').rows[0].n).toBe(0);
  });

  it('refuses a bundle over the entry cap with 413', async () => {
    const saved = config.interchange.maxEntries;
    config.interchange.maxEntries = 1;
    try {
      const { status, body } = await create();
      expect(status).toBe(413);
      expect(body.code).toBe('too_large');
    } finally {
      config.interchange.maxEntries = saved;
    }
  });
});

describe('POST /api/projects/:id/import (update)', () => {
  it('is idempotent: same bundle → no new commit, created:false, same checkpoint', async () => {
    const first = (await create()).body;
    const { status, body } = await update(first.project.id);
    expect(status).toBe(200);
    expect(body.files.every((f) => f.created === false)).toBe(true);
    expect(body.references.every((r) => r.status === 'matched')).toBe(true);
    expect(body.checkpoint).toBe(first.checkpoint);
  });

  it('rewrites citations when a key is renamed or matched under another key, and reports the map', async () => {
    const first = (await create()).body;
    const id = first.project.id;
    const refs = fixtureRefs();
    // A DIFFERENT paper now claims Berman2000 → renamed to Berman2000a; and
    // Zarate's PMID arrives under a new key → matched to the existing one.
    refs[0] = { ...refs[0], title: 'An unrelated paper', doi: '10.9999/unrelated', pmid: '99999999' };
    refs[1] = { ...refs[1], cite_key: 'zarate_2006' };
    const doc = fixtureDoc().replaceAll('Zarate2006', 'zarate_2006');
    const { status, body } = await update(id, bundle({ 'references.json': refs, 'files/draft/main.md': doc }));
    expect(status).toBe(200);
    expect(body.references).toEqual([
      { cite_key: 'Berman2000', status: 'renamed', actual_key: 'Berman2000a' },
      { cite_key: 'zarate_2006', status: 'matched', actual_key: 'Zarate2006' },
    ]);
    expect(body.citations_rewritten).toEqual({ 'draft/main.md': { Berman2000: 'Berman2000a', zarate_2006: 'Zarate2006' } });
    const written = await readDoc(id);
    expect(written).toContain('[@Berman2000a], and the effect');
    expect(written).toContain('[@Zarate2006; @Berman2000a]');
    expect(written).toContain('[@Zarate2006, p. 858]');
    expect(written).not.toContain('zarate_2006');
    expect(written).toContain('trial-office@example.org');
    expect(body.checkpoint).not.toBe(first.checkpoint);
    const bib = await readFile(join(root, String(id), 'draft/references.bib'), 'utf-8');
    expect(bib).toContain('@article{Berman2000a,');
  });

  it('re-anchors existing comments against the new text', async () => {
    const id = (await create()).body.project.id;
    const quote = 'Response rates exceeded 60%';
    const start = fixtureDoc().indexOf(quote);
    comments.createThread(id, { path: 'draft/main.md', body: 'check', quote, start, end: start + quote.length, userId: USERS.editorA.id });
    comments.createThread(id, { path: 'draft/main.md', body: 'gone', quote: 'Contact: trial-office@example.org', start: 0, end: 10, userId: USERS.editorA.id });

    const doc = `# Retitled\n\nA new opening paragraph.\n\n${fixtureDoc().replace('Contact: trial-office@example.org\n', '')}`;
    const { body } = await update(id, bundle({ 'files/draft/main.md': doc }));
    expect(body.comments).toEqual({ reanchored: 1, orphaned: 1 });
    const threads = comments.listThreads(id, { path: 'draft/main.md' });
    expect(threads.find((t) => t.body === 'check').anchor.start).toBe(doc.indexOf(quote));
    expect(threads.find((t) => t.body === 'gone').orphaned).toBe(true);
  });

  it('409s when a member has a target doc open, and force evicts the room', async () => {
    const id = (await create()).body.project.id;
    vi.mocked(evictRoom).mockClear(); // the create's own file events evict idle rooms
    roomState.memberConns.set(`project-${id}/draft/main.md`, 1);
    const refused = await update(id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'doc_open', paths: ['draft/main.md'] });
    expect(evictRoom).not.toHaveBeenCalled();

    const forced = await update(id, bundle(), { fields: { force: '1', label: 'round 2' } });
    expect(forced.status).toBe(200);
    expect(evictRoom).toHaveBeenCalledWith(`project-${id}/draft/main.md`, expect.objectContaining({ closeConnections: true }));
  });

  it('enforces tenancy: non-member 404, viewer 403, unknown project 404', async () => {
    const id = (await create()).body.project.id;
    expect((await update(id, bundle(), { user: 'ownerB' })).status).toBe(404);
    expect((await update(id, bundle(), { user: 'viewerA' })).status).toBe(403);
    expect((await update(9999)).status).toBe(404);
    expect((await update('abc')).status).toBe(400);
  });

  it('is additive: files absent from a later bundle stay put', async () => {
    const id = (await create()).body.project.id;
    const { status } = await update(id, bundle({ 'files/draft/figures/fig1.png': null }));
    expect(status).toBe(200);
    expect((await readFile(join(root, String(id), 'draft/figures/fig1.png'))).length).toBeGreaterThan(0);
  });
});

// ---- export ------------------------------------------------------------------

async function getExport(id, { user = 'editorA', query = '' } = {}) {
  const res = await fetch(`${base}/api/projects/${id}/export${query}`, { headers: { 'x-test-user': user } });
  if (res.headers.get('content-type')?.includes('application/zip')) {
    return { status: res.status, zip: Buffer.from(await res.arrayBuffer()) };
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('GET /api/projects/:id/export', () => {
  it('returns the feedback payload: docs, provenance, references, head revision', async () => {
    const created = (await create()).body;
    const { status, body } = await getExport(created.project.id, { user: 'viewerA' }); // viewer may export
    expect(status).toBe(200);
    expect(body.schema_version).toBe('1');
    expect(body.project).toEqual({ id: created.project.id, name: 'bendable2 — for review', project_type: 'manuscript' });
    expect(body.exported_by).toBe('viewer@a.org');
    expect(body.revision).toBe(created.checkpoint);
    expect(body.last_import).toMatchObject({ source: { tool: 'sciwriter' }, checkpoint: created.checkpoint });
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]).toMatchObject({
      path: 'draft/main.md',
      title: 'Ketamine for treatment-resistant depression',
      meta: { figure_numbering: { 'fig:forest': 1 } },
      modified_since_import: false,
      content: fixtureDoc(),
      comments: [],
    });
    expect(body.references.map((r) => r.cite_key)).toEqual(['Berman2000', 'Zarate2006']);
    expect(body.references[1]).toMatchObject({ authors: ['Zarate, C. A.', 'Singh, J. B.'], pmid: '16894061', entry_type: 'article' });
    expect(body.references[0]).not.toHaveProperty('id');
  });

  it('reflects edits and comments made in Kuhn, with authors normalized and anchors re-resolved', async () => {
    const id = (await create()).body.project.id;
    const quote = 'Response rates exceeded 60%';
    const doc = `# Retitled by a reviewer\n\n${fixtureDoc()}`;
    await writeProjectFile(id, 'draft/main.md', doc);
    const oldStart = fixtureDoc().indexOf(quote);
    const t = comments.createThread(id, { path: 'draft/main.md', body: 'Which trial?', quote, start: oldStart, end: oldStart + quote.length, userId: USERS.editorA.id });
    comments.addReply(id, t.id, { body: 'Zarate 2006.', agentSlug: 'reviewer' });
    const gone = comments.createThread(id, { path: 'draft/main.md', body: 'orphan me', quote: 'text that never existed', start: 5, end: 9, userId: USERS.viewerA.id });
    comments.setResolved(id, gone.id, true, { userId: USERS.editorA.id });
    querySync("INSERT INTO review_links (id, project_id, path, mode, token_hash, created_by, reviewer_name, expires_at) VALUES (77, $1, 'draft/main.md', 'comment', 'h', $2, 'A. Reviewer', '2999-01-01')", [id, USERS.editorA.id]);
    comments.createThread(id, { path: 'draft/main.md', body: 'from outside', reviewLinkId: 77 });

    const { body } = await getExport(id);
    const [d] = body.docs;
    expect(d.modified_since_import).toBe(true);
    expect(d.content).toBe(doc);
    expect(d.comments).toHaveLength(3);
    const [first, second, third] = d.comments;
    expect(first).toMatchObject({
      body: 'Which trial?',
      author: { kind: 'member', name: 'editorA', id: USERS.editorA.id },
      anchor: { quote, start: doc.indexOf(quote), end: doc.indexOf(quote) + quote.length },
      orphaned: false,
      resolved_at: null,
    });
    expect(first.replies).toEqual([expect.objectContaining({ body: 'Zarate 2006.', author: { kind: 'agent', name: 'reviewer', id: null } })]);
    expect(second).toMatchObject({ orphaned: true, anchor: { quote: 'text that never existed', start: 5, end: 9 }, resolved_by: 'editorA' });
    expect(second.resolved_at).toBeTruthy();
    expect(third).toMatchObject({ author: { kind: 'reviewer', name: 'A. Reviewer', id: 77 }, anchor: null });
    // Export never persisted the re-anchoring.
    expect(comments.listThreads(id, { path: 'draft/main.md' })[0].anchor.start).toBe(oldStart);
  });

  it('narrows to ?path=, 404s an unknown path, and enforces tenancy', async () => {
    const id = (await create()).body.project.id;
    await writeProjectFile(id, 'draft/extra.md', 'Extra doc.\n');
    expect((await getExport(id, { query: '?path=draft/extra.md' })).body.docs.map((d) => d.path)).toEqual(['draft/extra.md']);
    expect((await getExport(id, { query: '?path=draft/main.md&path=draft/extra.md' })).body.docs).toHaveLength(2);
    expect((await getExport(id)).body.docs.map((d) => d.path)).toEqual(['draft/main.md']); // default = last import
    expect((await getExport(id, { query: '?path=draft/nope.md' })).status).toBe(404);
    expect((await getExport(id, { query: '?path=../etc/passwd' })).status).toBe(403);
    expect((await getExport(id, { user: 'ownerB' })).status).toBe(404);
  });

  it('a never-imported project exports every markdown doc under draft/', async () => {
    const p = await createProject({ name: 'Plain', projectType: 'grant', orgId: 1 });
    await writeProjectFile(p.id, 'draft/a.md', 'A\n');
    await writeProjectFile(p.id, 'draft/sub/b.md', 'B\n');
    await writeProjectFile(p.id, 'draft/notes.txt', 'not a doc\n');
    await writeProjectFile(p.id, 'draft/references.bib', '% derived\n');
    const { body } = await getExport(p.id);
    expect(body.docs.map((d) => d.path)).toEqual(['draft/a.md', 'draft/sub/b.md']);
    expect(body.docs[0].modified_since_import).toBeNull();
    expect(body.last_import).toBeNull();
    expect(body.revision).toBeNull(); // no history yet — nothing has been committed
  });

  it('round-trips: export zip → import into a new project → export again is identical', async () => {
    const first = (await create()).body.project.id;
    await writeProjectFile(first, 'draft/tables/t1.csv', 'a,b\n1,2\n');
    const one = (await getExport(first)).body;
    const { status, zip } = await getExport(first, { query: '?format=zip' });
    expect(status).toBe(200);

    const imported = await post('/api/projects/import', zip);
    expect(imported.status).toBe(201);
    expect(imported.body.files.map((f) => f.path).sort()).toEqual(['draft/figures/fig1.png', 'draft/main.md', 'draft/tables/t1.csv']);
    expect(imported.body.references.every((r) => r.status === 'created' && r.actual_key === r.cite_key)).toBe(true);
    const two = (await getExport(imported.body.project.id)).body;

    expect(two.docs.map(({ path, content, title, meta }) => ({ path, content, title, meta })))
      .toEqual(one.docs.map(({ path, content, title, meta }) => ({ path, content, title, meta })));
    expect(two.references).toEqual(one.references);
    expect(two.last_import.source).toMatchObject({ tool: 'kuhn', project_id: first, revision: one.revision });
    expect((await readFile(join(root, String(imported.body.project.id), 'draft/figures/fig1.png'))).length).toBeGreaterThan(0);
  });
});
