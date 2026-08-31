import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

// Real in-memory DB (the theme SQL is the substance); guard + audit mocked.
process.env.KUHN_SQLITE_PATH = ':memory:';
vi.mock('../db/orgs.js', () => ({ checkOrgAccess: vi.fn() }));
vi.mock('../db/auth-events.js', () => ({ recordAuthEvent: vi.fn() }));

import { checkOrgAccess } from '../db/orgs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let server; let base; let querySync; let themesRoot;

beforeAll(async () => {
  const db = await import('../db.js');
  querySync = db.querySync;
  db.exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  const { config } = await import('../config.js');
  themesRoot = await mkdtemp(join(tmpdir(), 'kuhn-theme-routes-'));
  config.slideThemes.catalogRoot = themesRoot;

  const { default: slideThemesRouter } = await import('./slide-themes.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, email: 'dev@kuhn.local' }; next(); });
  app.use(slideThemesRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(themesRoot, { recursive: true, force: true });
});

beforeEach(() => {
  checkOrgAccess.mockReset();
  checkOrgAccess.mockImplementation(async (_u, orgId) => ({ ok: true, role: 'owner', org: { id: orgId } }));
  querySync('DELETE FROM org_slide_themes');
  querySync('DELETE FROM catalog_slide_themes');
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (10, 'A', 'a')");
  // created_by is a real FK — the stubbed req.user must exist.
  querySync("INSERT OR IGNORE INTO users (id, email) VALUES (1, 'dev@kuhn.local')");
  querySync("INSERT INTO catalog_slide_themes (name, title, path) VALUES ('kuhn', 'Kuhn', 'kuhn.css')");
});

const post = (body) => fetch(`${base}/api/orgs/10/slide-themes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('slide-theme routes (STH-58)', () => {
  it('GET catalog lists seeded themes', async () => {
    const res = await fetch(`${base}/api/slide-themes/catalog`);
    expect(res.status).toBe(200);
    expect((await res.json()).themes).toMatchObject([{ name: 'kuhn', available: true }]);
  });

  it('upload derives the name from the @theme header and upserts', async () => {
    expect((await post({ css: 'section {}' })).status).toBe(400); // no header
    expect((await post({ css: '/* @theme default */' })).status).toBe(400); // built-in

    const res = await post({ css: '/* @theme acme */ section {}', title: 'Acme brand' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.theme).toMatchObject({ name: 'acme', title: 'Acme brand', status: 'active' });
    expect(body.themes).toHaveLength(1);
    expect(body.catalog).toMatchObject([{ name: 'kuhn', shadowed: false }]);

    // An org theme named like a catalog theme shadows it in the payload.
    await post({ css: '/* @theme kuhn */ section {}' });
    const list = await (await fetch(`${base}/api/orgs/10/slide-themes`)).json();
    expect(list.catalog).toMatchObject([{ name: 'kuhn', shadowed: true }]);
  });

  it('GET one theme returns its CSS; PATCH toggles status; 404s are clean', async () => {
    await post({ css: '/* @theme acme */ body {}' });
    const one = await (await fetch(`${base}/api/orgs/10/slide-themes/acme`)).json();
    expect(one.css).toContain('@theme acme');

    const patched = await fetch(`${base}/api/orgs/10/slide-themes/acme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect((await patched.json()).theme.status).toBe('disabled');

    expect((await fetch(`${base}/api/orgs/10/slide-themes/ghost`)).status).toBe(404);
  });

  it('caps theme size', async () => {
    const { config } = await import('../config.js');
    const res = await post({ css: `/* @theme big */ ${'x'.repeat(config.slideThemes.maxThemeBytes + 1)}` });
    expect(res.status).toBe(413);
  });
});
