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
let comments; let getProject;
let evictRoom;
let server; let base; let root;
const USERS = {};

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  comments = await import('../db/comments.js');
  ({ getProject } = await import('../db/projects.js'));
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
