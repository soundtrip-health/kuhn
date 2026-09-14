import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

// Real in-memory DB (the doc-type SQL is the substance); guard + audit mocked.
process.env.KUHN_SQLITE_PATH = ':memory:';
vi.mock('../db/orgs.js', () => ({ checkOrgAccess: vi.fn() }));
vi.mock('../db/auth-events.js', () => ({ recordAuthEvent: vi.fn() }));

import { checkOrgAccess } from '../db/orgs.js';
import { recordAuthEvent } from '../db/auth-events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let server; let base; let querySync;

beforeAll(async () => {
  const db = await import('../db.js');
  querySync = db.querySync;
  db.exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const { default: docTypesRouter } = await import('./doc-types.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(docTypesRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  checkOrgAccess.mockReset();
  recordAuthEvent.mockReset();
  checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  querySync('DELETE FROM org_doc_types');
  querySync('DELETE FROM catalog_doc_types');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (10, 'A', 'a')");
  // created_by is a real FK — the stubbed req.user must exist.
  querySync("INSERT OR IGNORE INTO users (id, email) VALUES (1, 'dev@kuhn.local')");
  querySync(`INSERT INTO catalog_doc_types (slug, title, description, default_template, wizard_hints, guidance, sort_order)
             VALUES ('manuscript', 'Manuscript', 'IMRaD', 'manuscript', '["papers"]', 'Write IMRaD.', 0)`);
});

const json = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body) => json('POST', '/api/orgs/10/doc-types', body);

describe('doc-type routes (issue #106)', () => {
  it('GET catalog lists seeded types with hints and guidance', async () => {
    const res = await fetch(`${base}/api/doc-types/catalog`);
    expect(res.status).toBe(200);
    expect((await res.json()).types).toMatchObject([
      { slug: 'manuscript', title: 'Manuscript', available: true, wizard_hints: ['papers'], guidance: 'Write IMRaD.' },
    ]);
  });

  it('GET org payload carries catalog, org rows, and the effective list', async () => {
    const res = await fetch(`${base}/api/orgs/10/doc-types`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog).toMatchObject([{ slug: 'manuscript', shadowed: false }]);
    expect(body.types).toEqual([]);
    expect(body.effective).toMatchObject([{ slug: 'manuscript', source: 'catalog' }]);
  });

  it('POST validates the slug and title, upserts, audits, and reports shadowing', async () => {
    expect((await post({ slug: 'Bad Slug', title: 'X' })).status).toBe(400);
    expect((await post({ slug: 'white-paper' })).status).toBe(400); // no title
    expect((await post({ slug: 'white-paper', title: 'W', wizard_hints: 'nope' })).status).toBe(400);

    const res = await post({
      slug: 'White-Paper', title: 'White paper', description: 'Industry brief',
      default_template: 'manuscript', wizard_hints: ['a', ' b '], guidance: 'Short.',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toMatchObject({
      slug: 'white-paper', title: 'White paper', status: 'active', wizard_hints: ['a', 'b'], default_template: 'manuscript',
    });
    expect(body.effective.map((t) => [t.slug, t.source])).toEqual([['manuscript', 'catalog'], ['white-paper', 'org']]);
    expect(recordAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'doc_type.upsert', orgId: 10, meta: { doc_type: 'white-paper' } }));

    // An org type named like a catalog type shadows it in the payload.
    await post({ slug: 'manuscript', title: 'Manuscript (house)' });
    const list = await (await fetch(`${base}/api/orgs/10/doc-types`)).json();
    expect(list.catalog).toMatchObject([{ slug: 'manuscript', shadowed: true }]);
    expect(list.effective[0]).toMatchObject({ slug: 'manuscript', source: 'org', title: 'Manuscript (house)' });
  });

  it('PATCH toggles status (audited) and 404s cleanly; a disabled shadow falls back to the catalog', async () => {
    await post({ slug: 'manuscript', title: 'Manuscript (house)' });
    expect((await json('PATCH', '/api/orgs/10/doc-types/manuscript', { status: 'bogus' })).status).toBe(400);
    const patched = await json('PATCH', '/api/orgs/10/doc-types/manuscript', { status: 'disabled' });
    expect((await patched.json()).type.status).toBe('disabled');
    expect(recordAuthEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'doc_type.disable' }));
    const list = await (await fetch(`${base}/api/orgs/10/doc-types`)).json();
    expect(list.catalog).toMatchObject([{ slug: 'manuscript', shadowed: false }]);
    expect(list.effective).toMatchObject([{ slug: 'manuscript', source: 'catalog' }]);

    expect((await json('PATCH', '/api/orgs/10/doc-types/ghost', { status: 'active' })).status).toBe(404);
  });

  it('caps guidance size', async () => {
    const { config } = await import('../config.js');
    const res = await post({ slug: 'big', title: 'Big', guidance: 'x'.repeat(config.docTypes.maxGuidanceBytes + 1) });
    expect(res.status).toBe(413);
  });

  it('writes are owner-only; reads are member-level', async () => {
    checkOrgAccess.mockImplementation(async (_u, _o, minRole) =>
      (minRole === 'owner' ? { ok: false, reason: 'role' } : { ok: true, role: 'viewer', org: { id: 10 } }));
    expect((await fetch(`${base}/api/orgs/10/doc-types`)).status).toBe(200);
    expect((await post({ slug: 'white-paper', title: 'W' })).status).toBe(403);
  });
});
