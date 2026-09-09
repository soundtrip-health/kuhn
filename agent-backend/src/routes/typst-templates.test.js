import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

// Real in-memory DB (the template SQL is the substance); guard + audit mocked.
process.env.KUHN_SQLITE_PATH = ':memory:';
vi.mock('../db/orgs.js', () => ({ checkOrgAccess: vi.fn() }));
vi.mock('../db/auth-events.js', () => ({ recordAuthEvent: vi.fn() }));

import { checkOrgAccess } from '../db/orgs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let server; let base; let querySync; let tplRoot;

beforeAll(async () => {
  const db = await import('../db.js');
  querySync = db.querySync;
  db.exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  const { config } = await import('../config.js');
  tplRoot = await mkdtemp(join(tmpdir(), 'kuhn-template-routes-'));
  config.typstTemplates.catalogRoot = tplRoot;

  const { default: router } = await import('./typst-templates.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(router);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(tplRoot, { recursive: true, force: true });
});

beforeEach(() => {
  checkOrgAccess.mockReset();
  checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  querySync('DELETE FROM org_typst_templates');
  querySync('DELETE FROM catalog_typst_templates');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (10, 'A', 'a')");
  querySync("INSERT OR IGNORE INTO users (id, email) VALUES (1, 'dev@kuhn.local')");
  querySync("INSERT INTO catalog_typst_templates (name, title, path) VALUES ('nih-grant', 'NIH', 'nih-grant.typ')");
});

const CONF = '#let conf(title: none, doc) = { doc }';
const post = (body) => fetch(`${base}/api/orgs/10/typst-templates`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('typst-template routes', () => {
  it('GET catalog lists seeded templates', async () => {
    const res = await fetch(`${base}/api/typst-templates/catalog`);
    expect(res.status).toBe(200);
    expect((await res.json()).templates).toMatchObject([{ name: 'nih-grant', available: true }]);
  });

  it('upload derives the name from the @template header, requires conf, and upserts', async () => {
    expect((await post({ source: CONF })).status).toBe(400); // no header
    expect((await post({ source: '// @template acme\n#let other() = 1' })).status).toBe(400); // no conf

    const res = await post({ source: `// @template acme\n${CONF}`, title: 'Acme letterhead' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toMatchObject({ name: 'acme', title: 'Acme letterhead', status: 'active' });
    expect(body.templates).toHaveLength(1);
    expect(body.catalog).toMatchObject([{ name: 'nih-grant', shadowed: false }]);

    await post({ source: `// @template nih-grant\n${CONF}` });
    const list = await (await fetch(`${base}/api/orgs/10/typst-templates`)).json();
    expect(list.catalog).toMatchObject([{ name: 'nih-grant', shadowed: true }]);
  });

  it('GET one template returns its source; PATCH toggles status; 404s are clean', async () => {
    await post({ source: `// @template acme\n${CONF}` });
    const one = await (await fetch(`${base}/api/orgs/10/typst-templates/acme`)).json();
    expect(one.source).toContain('@template acme');

    const patched = await fetch(`${base}/api/orgs/10/typst-templates/acme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect((await patched.json()).template.status).toBe('disabled');
    expect((await fetch(`${base}/api/orgs/10/typst-templates/ghost`)).status).toBe(404);
  });

  it('non-owners can read but not write', async () => {
    checkOrgAccess.mockImplementation(async (_u, orgId, minRole) => (
      minRole === 'owner' ? { ok: false, reason: 'forbidden' } : { ok: true, role: 'viewer', org: { id: orgId } }
    ));
    expect((await fetch(`${base}/api/orgs/10/typst-templates`)).status).toBe(200);
    expect((await post({ source: `// @template acme\n${CONF}` })).status).not.toBe(200);
  });

  it('PUT/GET docx attaches and serves a Word reference document; non-zip bodies are refused', async () => {
    await post({ source: `// @template acme\n${CONF}` });
    const put = (body, type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') =>
      fetch(`${base}/api/orgs/10/typst-templates/acme/docx`, { method: 'PUT', headers: { 'Content-Type': type }, body });
    expect((await put('not a zip')).status).toBe(400);
    const ok = await put(Buffer.from('PK\x03\x04ref'));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.template).toMatchObject({ name: 'acme', docx_bytes: 7 });
    expect(body.templates[0].docx_bytes).toBe(7);
    expect(body.catalog).toMatchObject([{ name: 'nih-grant', docx: false }]);

    const got = await fetch(`${base}/api/orgs/10/typst-templates/acme/docx`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toMatch(/wordprocessingml/);
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe('PK\x03\x04ref');

    expect((await put('')).status).toBe(200); // empty body removes it
    expect((await fetch(`${base}/api/orgs/10/typst-templates/acme/docx`)).status).toBe(404);
    expect((await fetch(`${base}/api/orgs/10/typst-templates/ghost/docx`, { method: 'PUT', body: Buffer.from('PK\x03\x04x') })).status).toBe(404);
  });

  it('caps template size', async () => {
    const { config } = await import('../config.js');
    const res = await post({ source: `// @template big\n${CONF}\n// ${'x'.repeat(config.typstTemplates.maxTemplateBytes + 1)}` });
    expect(res.status).toBe(413);
  });
});
