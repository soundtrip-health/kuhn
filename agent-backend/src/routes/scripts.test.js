// Issue #68a: shared-script library mechanics — catalog views, org import /
// status / reimport with version history, and the promote → review → approve
// flow with its sha-drift and slug-conflict refusals. Tenancy sweeps for
// these routes live in tenancy-matrix.test.js. Real SQLite + real catalog and
// project files in temp dirs; the agent pipeline is mocked (projects.js pulls
// it in for unrelated routes).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

vi.mock('../ingest.js', () => ({ queueIngest: vi.fn() }));
vi.mock('../agents/seeding.js', () => ({ runSeedPipeline: vi.fn(() => (async function* () {})()) }));
vi.mock('../agents/runtime.js', () => ({
  runAgentTask: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
  reattach: vi.fn(() => (async function* () {})()),
}));

const ORG = 1;
const PROJECT = 10;
const CATALOG_ID = 'r/summarize-csv';

let config; let querySync;
let server; let base; let cookies = {};
let catalogRoot; let projectsRoot; let saved;

function call(method, path, principal = 'owner', json) {
  const headers = { Cookie: `kuhn_session=${encodeURIComponent(cookies[principal])}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return fetch(new URL(path, base), { method, headers, body });
}

const eventTypes = () =>
  querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type);

const sha = async (text) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
};

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  saved = {
    mode: config.auth.mode,
    secret: config.auth.sessionSecret,
    catalogRoot: config.scripts.catalogRoot,
    projectsRoot: config.agent.projectsRoot,
    history: config.history.enabled,
  };
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  config.history.enabled = false;
  catalogRoot = await mkdtemp(join(tmpdir(), 'kuhn-scripts-catalog-'));
  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-scripts-projects-'));
  config.scripts.catalogRoot = catalogRoot;
  config.agent.projectsRoot = projectsRoot;

  await mkdir(join(catalogRoot, 'r'), { recursive: true });
  await writeFile(join(catalogRoot, 'r', 'summarize_csv.R'), 'cat("v1")\n');
  await writeFile(join(catalogRoot, 'catalog.json'), JSON.stringify({
    catalog_version: 1,
    scripts: [
      {
        id: CATALOG_ID, title: 'Summarize CSV', language: 'r',
        path: 'r/summarize_csv.R', entrypoint: 'summarize_csv.R', version: 1,
        description: 'EDA summary', args: [{ name: '--input', required: true }], tags: ['r'],
      },
      {
        id: 'r/absent', title: 'Absent', language: 'r',
        path: 'r/absent.R', entrypoint: 'absent.R', version: 1,
      },
    ],
  }));

  await mkdir(join(projectsRoot, String(PROJECT), 'analyst'), { recursive: true });
  await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'gamm_fit.R'), 'library(mgcv)\n');
  await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'notes.md'), 'not a script\n');

  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf-8'));
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org', 'org')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@test'), (2, 'editor@test'), (3, 'viewer@test')");
  querySync(`INSERT INTO memberships (user_id, org_id, role)
             VALUES (1, ${ORG}, 'owner'), (2, ${ORG}, 'editor'), (3, ${ORG}, 'viewer')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${PROJECT}, ${ORG}, 'Trial', 'manuscript')`);

  const { seedScriptCatalog } = await import('../db/seed.js');
  await seedScriptCatalog();

  const { createSession } = await import('../db/auth.js');
  cookies.owner = (await createSession(1)).cookieValue;
  cookies.editor = (await createSession(2)).cookieValue;
  cookies.viewer = (await createSession(3)).cookieValue;

  const { session } = await import('../session.js');
  const app = express();
  app.use(express.json());
  app.use(session);
  app.use((await import('./scripts.js')).default);
  app.use((await import('./projects.js')).default);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = saved.mode;
  config.auth.sessionSecret = saved.secret;
  config.scripts.catalogRoot = saved.catalogRoot;
  config.agent.projectsRoot = saved.projectsRoot;
  config.history.enabled = saved.history;
  await new Promise((ok) => server.close(ok));
  await rm(catalogRoot, { recursive: true, force: true });
  await rm(projectsRoot, { recursive: true, force: true });
});

describe('catalog views', () => {
  it('GET /api/scripts/catalog serves the seeded catalog to any member', async () => {
    const res = await call('GET', '/api/scripts/catalog', 'viewer');
    expect(res.status).toBe(200);
    const { scripts } = await res.json();
    expect(scripts).toHaveLength(2);
    expect(scripts.find((s) => s.id === CATALOG_ID)).toMatchObject({
      language: 'r', version: 1, available: true, args: [{ name: '--input', required: true }],
    });
    expect(scripts.find((s) => s.id === 'r/absent')).toMatchObject({ available: false });
  });

  it('GET /api/orgs/:orgId/scripts merges org state (nothing imported yet)', async () => {
    const res = await call('GET', `/api/orgs/${ORG}/scripts`, 'viewer');
    expect(res.status).toBe(200);
    const { catalog, scripts } = await res.json();
    expect(scripts).toEqual([]);
    expect(catalog.find((s) => s.id === CATALOG_ID)).toMatchObject({
      org_script_id: null, org_script_status: null,
    });
  });
});

describe('import / status / reimport', () => {
  it('owner import copies the catalog code as version 1', async () => {
    const res = await call('POST', `/api/orgs/${ORG}/scripts/import`, 'owner', { scripts: [CATALOG_ID] });
    expect(res.status).toBe(200);
    const { catalog, scripts } = await res.json();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      slug: 'summarize-csv', source: 'catalog-import', status: 'active',
      catalog_script_id: CATALOG_ID, catalog_script_version: 1,
      current_version: 1, update_available: false,
    });
    expect(catalog.find((s) => s.id === CATALOG_ID).org_script_id).toBe(scripts[0].id);
    expect(eventTypes()).toContain('script.import');

    const detail = await (await call('GET', `/api/orgs/${ORG}/scripts/summarize-csv`, 'viewer')).json();
    expect(detail.content).toBe('cat("v1")\n');
    expect(detail.versions.map((v) => v.version)).toEqual([1]);
  });

  it('editors cannot import; unavailable scripts refuse', async () => {
    expect((await call('POST', `/api/orgs/${ORG}/scripts/import`, 'editor', { scripts: [CATALOG_ID] })).status).toBe(403);
    const res = await call('POST', `/api/orgs/${ORG}/scripts/import`, 'owner', { scripts: ['r/absent'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('unavailable');
  });

  it('status toggle disables without deleting and re-import re-activates', async () => {
    const off = await call('PATCH', `/api/orgs/${ORG}/scripts/summarize-csv`, 'owner', { status: 'disabled' });
    expect((await off.json()).script.status).toBe('disabled');
    const back = await call('POST', `/api/orgs/${ORG}/scripts/import`, 'owner', { scripts: [CATALOG_ID] });
    const { scripts } = await back.json();
    expect(scripts[0]).toMatchObject({ status: 'active', current_version: 1 }); // no new version
  });

  it('catalog bump → update_available → reimport appends a version', async () => {
    querySync(`UPDATE catalog_scripts SET version = 2 WHERE id = '${CATALOG_ID}'`);
    let { scripts } = await (await call('GET', `/api/orgs/${ORG}/scripts`, 'owner')).json();
    expect(scripts[0].update_available).toBe(true);

    // Identical bytes: restamp only.
    let res = await call('POST', `/api/orgs/${ORG}/scripts/reimport`, 'owner', { scripts: [CATALOG_ID] });
    ({ scripts } = await res.json());
    expect(scripts[0]).toMatchObject({
      catalog_script_version: 2, current_version: 1, update_available: false,
    });

    // Changed bytes: new version row, history preserved.
    querySync(`UPDATE catalog_scripts SET version = 3 WHERE id = '${CATALOG_ID}'`);
    await writeFile(join(catalogRoot, 'r', 'summarize_csv.R'), 'cat("v3")\n');
    res = await call('POST', `/api/orgs/${ORG}/scripts/reimport`, 'owner', { scripts: [CATALOG_ID] });
    ({ scripts } = await res.json());
    expect(scripts[0]).toMatchObject({ catalog_script_version: 3, current_version: 2 });
    const detail = await (await call('GET', `/api/orgs/${ORG}/scripts/summarize-csv`, 'viewer')).json();
    expect(detail.content).toBe('cat("v3")\n');
    const v1 = await (await call('GET', `/api/orgs/${ORG}/scripts/summarize-csv/versions/1`, 'viewer')).json();
    expect(v1.version.content).toBe('cat("v1")\n');
  });
});

describe('promotion flow', () => {
  it('refuses non-script files', async () => {
    const res = await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', { path: 'analyst/notes.md' });
    expect(res.status).toBe(400);
  });

  it('editor suggestion is 202 pending; duplicate returns the same request with 200', async () => {
    const first = await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', {
      path: 'analyst/gamm_fit.R', title: 'GAMM fit', note: 'reusable',
    });
    expect(first.status).toBe(202);
    const { request } = await first.json();
    expect(request).toMatchObject({ language: 'r', status: 'pending', title: 'GAMM fit' });

    const dup = await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', { path: 'analyst/gamm_fit.R' });
    expect(dup.status).toBe(200);
    expect((await dup.json()).request.id).toBe(request.id);
  });

  it('owner reviews with live content + sha, then approves; drift reverts with 409', async () => {
    const { requests } = await (await call('GET', `/api/orgs/${ORG}/script-promotions?status=pending`, 'owner')).json();
    expect(requests).toHaveLength(1);
    const id = requests[0].id;

    const detail = await (await call('GET', `/api/orgs/${ORG}/script-promotions/${id}`, 'owner')).json();
    expect(detail.content).toBe('library(mgcv)\n');
    expect(detail.sha256).toBe(await sha('library(mgcv)\n'));
    expect(detail.target_content).toBeNull();

    // The file changes between review and decision → 409, back to pending.
    await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'gamm_fit.R'), 'library(mgcv) # edited\n');
    const drift = await call('POST', `/api/orgs/${ORG}/script-promotions/${id}/approve`, 'owner', {
      expected_sha256: detail.sha256,
    });
    expect(drift.status).toBe(409);
    expect((await (await call('GET', `/api/orgs/${ORG}/script-promotions/${id}`, 'owner')).json()).request.status).toBe('pending');

    // Re-review the current content and approve.
    const fresh = await (await call('GET', `/api/orgs/${ORG}/script-promotions/${id}`, 'owner')).json();
    const ok = await call('POST', `/api/orgs/${ORG}/script-promotions/${id}/approve`, 'owner', {
      expected_sha256: fresh.sha256, slug: 'gamm-fit', decision_note: 'lgtm',
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.request).toMatchObject({ status: 'approved', decision_note: 'lgtm' });
    expect(body.script).toMatchObject({
      slug: 'gamm-fit', source: 'project-promotion', current_version: 1,
    });
    expect(eventTypes()).toContain('script.promotion.approved');

    const detail2 = await (await call('GET', `/api/orgs/${ORG}/scripts/gamm-fit`, 'viewer')).json();
    expect(detail2.content).toBe('library(mgcv) # edited\n');
    expect(detail2.versions[0]).toMatchObject({ source_path: 'analyst/gamm_fit.R' });
  });

  it('slug conflict reverts the claim with 409', async () => {
    await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'other.R'), 'x <- 1\n');
    const filed = await (await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', { path: 'analyst/other.R' })).json();
    const detail = await (await call('GET', `/api/orgs/${ORG}/script-promotions/${filed.request.id}`, 'owner')).json();
    const res = await call('POST', `/api/orgs/${ORG}/script-promotions/${filed.request.id}/approve`, 'owner', {
      expected_sha256: detail.sha256, slug: 'gamm-fit', // taken above
    });
    expect(res.status).toBe(409);
    expect(detail.request.status).toBe('pending');
    const reject = await call('POST', `/api/orgs/${ORG}/script-promotions/${filed.request.id}/reject`, 'owner', {
      decision_note: 'duplicate',
    });
    expect(reject.status).toBe(200);
    expect((await reject.json()).request.status).toBe('rejected');
    expect(eventTypes()).toContain('script.promotion.rejected');
  });

  it('update proposals target an existing script and approval appends a version', async () => {
    const scriptId = querySync("SELECT id FROM org_scripts WHERE slug = 'gamm-fit'").rows[0].id;
    await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'gamm_fit.R'), 'library(mgcv) # v2\n');
    const filed = await (await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', {
      path: 'analyst/gamm_fit.R', target_script_id: scriptId, note: 'handles AR1',
    })).json();
    expect(filed.request.target_script_slug).toBe('gamm-fit');

    const detail = await (await call('GET', `/api/orgs/${ORG}/script-promotions/${filed.request.id}`, 'owner')).json();
    expect(detail.target_content).toBe('library(mgcv) # edited\n'); // current version, for diffing
    const ok = await call('POST', `/api/orgs/${ORG}/script-promotions/${filed.request.id}/approve`, 'owner', {
      expected_sha256: detail.sha256,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).script).toMatchObject({ slug: 'gamm-fit', current_version: 2 });
  });

  it('owners take the direct path: immediate copy, no request', async () => {
    await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'direct.R'), 'y <- 2\n');
    const res = await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'owner', {
      path: 'analyst/direct.R', title: 'Direct', slug: 'direct-script',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).script).toMatchObject({ slug: 'direct-script', current_version: 1 });
    expect(querySync("SELECT * FROM script_promotion_requests WHERE path = 'analyst/direct.R'").rows).toHaveLength(0);
  });

  it("promotion_policy 'direct' lets editors copy immediately too", async () => {
    querySync(`UPDATE organizations SET settings = '{"promotion_policy":"direct"}' WHERE id = ${ORG}`);
    await writeFile(join(projectsRoot, String(PROJECT), 'analyst', 'editor_direct.R'), 'z <- 3\n');
    const res = await call('POST', `/api/projects/${PROJECT}/files/promote-script`, 'editor', {
      path: 'analyst/editor_direct.R',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).script.slug).toBe('editor-direct');
    querySync(`UPDATE organizations SET settings = '{}' WHERE id = ${ORG}`);
  });
});
