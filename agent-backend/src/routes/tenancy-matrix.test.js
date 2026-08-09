// Epic 011 closure gate: the tenancy matrix. One real-SQLite integration
// suite that mounts every tenant-scoped router (the same set index.js mounts
// after session()) and sweeps the audited route table across principals ×
// org status:
//
//   ownerA / editorA / viewerA — members of org A at each role
//   strangerB                  — owner of org B, no membership in A (cross-tenant)
//   superadmin                 — is_superadmin=1, member of NOTHING (011-001's
//                                invariant: a super-admin without a membership
//                                is a stranger to every org's content)
//
// Expectations are the shipped guard contract (routes/guards.js), verbatim —
// the webapp's role-refresh regex matches these exact strings:
//   below threshold  → 403 { error: 'requires <minRole> role' }
//   non-member / SA  → 404 { error: 'project not found' | 'organization not found' }
//   suspended org    → 403 { error: 'organization suspended' }
//   non-SA on /admin → 403 { error: 'super-admin required' }
//
// Heavy runtimes are mocked (agent SDK, seeding pipeline, mail, ingestion);
// the DB layer, guards, session resolution, and storage are all real.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

// Mail is captured, never sent/logged.
vi.mock('../mailer.js', () => ({
  sendLoginLink: vi.fn(async () => {}),
  sendInviteLink: vi.fn(async () => {}),
}));
// Library ingestion is out of scope here (006-002 has its own tests) — and
// unmocked it would chunk/FTS-index every upload in the background.
vi.mock('../ingest.js', () => ({ queueIngest: vi.fn() }));
// The agent runtime spends model quota; the matrix only cares that the guard
// let the request through to it (or didn't).
vi.mock('../agents/runtime.js', () => ({
  runAgentTask: vi.fn(() => (async function* () { yield { type: 'done' }; })()),
  reattach: vi.fn(() => (async function* () {})()),
}));
vi.mock('../agents/seeding.js', () => ({
  runSeedPipeline: vi.fn(() => (async function* () {})()),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixture ids (explicit, so paths in the route table can be literals).
const ORG_A = 1;
const ORG_B = 2;
const PROJECT_A = 1; // in org A
const PROJECT_B = 2; // in org B
const JOB_A = 1;     // job in project A

let config; let exec; let querySync;
let server; let base;
let projectsRoot; let orgsRoot;
let saved;

/** cookie per principal, minted once the fixture users exist */
const cookies = {};

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  saved = {
    mode: config.auth.mode,
    secret: config.auth.sessionSecret,
    projectsRoot: config.agent.projectsRoot,
    orgsRoot: config.storage.orgsRoot,
    history: config.history.enabled,
  };
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  config.history.enabled = false; // no git side-band; history has its own tests

  projectsRoot = await mkdtemp(join(tmpdir(), 'kuhn-matrix-projects-'));
  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-matrix-orgs-'));
  config.agent.projectsRoot = projectsRoot;
  config.storage.orgsRoot = orgsRoot;
  for (const id of [PROJECT_A, PROJECT_B]) {
    await mkdir(join(projectsRoot, String(id), 'draft'), { recursive: true });
    await writeFile(join(projectsRoot, String(id), 'draft', 'main.md'), `# Project ${id}\n`);
  }

  ({ exec, querySync } = await import('../db.js'));
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A}, 'Org A', 'org-a')`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'org-b')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@a.test')");
  querySync("INSERT INTO users (id, email) VALUES (2, 'editor@a.test')");
  querySync("INSERT INTO users (id, email) VALUES (3, 'viewer@a.test')");
  querySync("INSERT INTO users (id, email, is_superadmin) VALUES (4, 'root@platform.test', 1)");
  querySync("INSERT INTO users (id, email) VALUES (5, 'owner@b.test')");
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (1, ${ORG_A}, 'owner')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (2, ${ORG_A}, 'editor')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (3, ${ORG_A}, 'viewer')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (5, ${ORG_B}, 'owner')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${PROJECT_A}, ${ORG_A}, 'Alpha', 'manuscript')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${PROJECT_B}, ${ORG_B}, 'Beta', 'manuscript')`);
  querySync(`INSERT INTO jobs (id, project_id, user_id, role, status, input)
             VALUES (${JOB_A}, ${PROJECT_A}, 2, 'writer', 'done', 'draft the intro')`);

  const { createSession } = await import('../db/auth.js');
  for (const [name, userId] of [
    ['owner', 1], ['editor', 2], ['viewer', 3], ['superadmin', 4], ['stranger', 5],
  ]) {
    cookies[name] = (await createSession(userId)).cookieValue;
  }

  const { session } = await import('../session.js');
  const app = express();
  app.use(express.json());
  app.use(session);
  // The full post-session() tenant surface, in index.js mount order.
  for (const mod of [
    './agent.js', './citations.js', './comments.js', './files.js', './history.js',
    './orgs.js', './org-admin.js', './org-library.js', './pending-edits.js',
    './projects.js', './promotions.js', './render.js', './review-links.js',
  ]) {
    app.use((await import(mod)).default);
  }
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = saved.mode;
  config.auth.sessionSecret = saved.secret;
  config.agent.projectsRoot = saved.projectsRoot;
  config.storage.orgsRoot = saved.orgsRoot;
  config.history.enabled = saved.history;
  await new Promise((ok) => server.close(ok));
  await rm(projectsRoot, { recursive: true, force: true });
  await rm(orgsRoot, { recursive: true, force: true });
});

/** One request as a principal. `req` carries json | text | form | query. */
function call(method, path, principal, req = {}) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers = { Cookie: `kuhn_session=${encodeURIComponent(cookies[principal])}` };
  let body;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.text !== undefined) {
    headers['Content-Type'] = 'text/plain';
    body = req.text;
  } else if (req.form) {
    body = req.form();
  }
  return fetch(url, { method, headers, body, redirect: 'manual' });
}

const smallUpload = () => {
  const form = new FormData();
  form.append('files', new Blob(['matrix bytes'], { type: 'text/markdown' }), 'matrix-upload.md');
  return form;
};

/**
 * THE AUDITED ROUTE TABLE (plan §1.5 as shipped). Every tenant-scoped route,
 * its threshold, and a cheap at-threshold expectation proving the guard let
 * the request through (400s here are the route's own post-guard validation;
 * 404s carry route-specific bodies distinct from the guard's non-leak 404).
 * `req` is a factory so form bodies are fresh per call; requests are shaped
 * to clear any pre-guard validation, so refusal sweeps always hit the guard.
 */
const ROUTES = [
  // -- project-scoped reads (viewer) --------------------------------------
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/files`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/file`, req: () => ({ query: { path: 'draft/main.md' } }), ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/history`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/history/file`, ok: { status: 400 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/pending-edits`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'POST', path: `/api/projects/${PROJECT_A}/render`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/export`, ok: { status: 400 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/citations/search`, ok: { status: 400 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/references`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/comments`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/comments/counts`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/review-links`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'POST', path: `/api/projects/${PROJECT_A}/files/seen`, req: () => ({ json: { path: 'draft/main.md' } }), ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/files/activity`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/events`, sse: true },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/projects/${PROJECT_A}/conversations`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: '/api/agent/jobs', req: () => ({ query: { projectId: String(PROJECT_A) } }), ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: `/api/agent/jobs/${JOB_A}/trace`, ok: { status: 200 } },
  { scope: 'project', minRole: 'viewer', method: 'GET', path: '/api/agent/pending', req: () => ({ query: { projectId: String(PROJECT_A) } }), ok: { status: 200 } },

  // -- project-scoped writes (editor) -------------------------------------
  { scope: 'project', minRole: 'editor', method: 'PUT', path: `/api/projects/${PROJECT_A}/file`, req: () => ({ query: { path: 'matrix-write.md' }, text: 'written by the matrix' }), ok: { status: 201 } },
  { scope: 'project', minRole: 'editor', method: 'DELETE', path: `/api/projects/${PROJECT_A}/file`, req: () => ({ query: { path: 'matrix-write.md' } }), ok: { status: 200 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/files/mkdir`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/files/move`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/files/upload`, req: () => ({ form: smallUpload }), ok: { status: 201 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/history/restore`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/pending-edits`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/pending-edits/abc/accept`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/pending-edits/abc/reject`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/citations`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/comments`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/comments/abc/replies`, req: () => ({ json: { body: 'x' } }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/comments/abc/resolve`, ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/comments/abc/reopen`, ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'PATCH', path: `/api/projects/${PROJECT_A}/comments/abc/anchor`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'DELETE', path: `/api/projects/${PROJECT_A}/comments/abc`, ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/review-links`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/review-links/abc/revoke`, ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'PATCH', path: `/api/projects/${PROJECT_A}`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'PUT', path: `/api/projects/${PROJECT_A}/config`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'PUT', path: `/api/projects/${PROJECT_A}/active-document`, req: () => ({ json: {} }), ok: { status: 400 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/seed`, sse: true },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/projects/${PROJECT_A}/files/promote`, req: () => ({ json: { path: 'draft/main.md' } }), ok: { status: 202 } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: '/api/agent/task', req: () => ({ json: { role: 'writer', projectId: PROJECT_A, input: 'hi' } }), sse: true },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/agent/jobs/${JOB_A}/dispatch`, sse: true },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/agent/jobs/${JOB_A}/reply`, req: () => ({ json: { reply: 'x' } }), ok: { status: 409, error: 'no pending question for this job' } },
  { scope: 'project', minRole: 'editor', method: 'POST', path: `/api/agent/jobs/${JOB_A}/reconnect`, ok: { status: 404, error: 'no live run for this job' } },

  // -- org-scoped (viewer reads) -------------------------------------------
  { scope: 'org', minRole: 'viewer', method: 'GET', path: `/api/orgs/${ORG_A}/projects`, ok: { status: 200 } },
  { scope: 'org', minRole: 'viewer', method: 'GET', path: `/api/orgs/${ORG_A}/library`, ok: { status: 200 } },
  { scope: 'org', minRole: 'viewer', method: 'GET', path: `/api/orgs/${ORG_A}/library/999`, ok: { status: 404, error: 'document not found' } },
  { scope: 'org', minRole: 'viewer', method: 'GET', path: `/api/orgs/${ORG_A}/library/999/content`, ok: { status: 404, error: 'document not found' } },
  { scope: 'org', minRole: 'viewer', method: 'GET', path: `/api/orgs/${ORG_A}/events`, sse: true },

  // -- org-scoped (editor writes) --------------------------------------------
  { scope: 'org', minRole: 'editor', method: 'POST', path: `/api/orgs/${ORG_A}/library/upload`, req: () => ({ form: smallUpload }), ok: { status: 201 } },
  { scope: 'org', minRole: 'editor', method: 'POST', path: '/api/projects', req: () => ({ json: { name: 'Matrix Editor Project', orgId: ORG_A } }), ok: { status: 201 } },

  // -- org-scoped (owner only) ----------------------------------------------
  { scope: 'org', minRole: 'owner', method: 'DELETE', path: `/api/orgs/${ORG_A}/library/999`, ok: { status: 404, error: 'document not found' } },
  { scope: 'org', minRole: 'owner', method: 'GET', path: `/api/orgs/${ORG_A}/members`, ok: { status: 200 } },
  { scope: 'org', minRole: 'owner', method: 'PATCH', path: `/api/orgs/${ORG_A}/members/999`, req: () => ({ json: { role: 'viewer' } }), ok: { status: 404, error: 'member not found' } },
  { scope: 'org', minRole: 'owner', method: 'DELETE', path: `/api/orgs/${ORG_A}/members/999`, ok: { status: 404, error: 'member not found' } },
  { scope: 'org', minRole: 'owner', method: 'GET', path: `/api/orgs/${ORG_A}/invitations`, ok: { status: 200 } },
  { scope: 'org', minRole: 'owner', method: 'POST', path: `/api/orgs/${ORG_A}/invitations`, req: () => ({ json: { email: 'matrix-invite@example.org', role: 'viewer' } }), ok: { status: 201 } },
  { scope: 'org', minRole: 'owner', method: 'DELETE', path: `/api/orgs/${ORG_A}/invitations/999`, ok: { status: 404, error: 'invitation not found' } },
  { scope: 'org', minRole: 'owner', method: 'GET', path: `/api/orgs/${ORG_A}/settings`, ok: { status: 200 } },
  { scope: 'org', minRole: 'owner', method: 'PATCH', path: `/api/orgs/${ORG_A}/settings`, req: () => ({ json: { promotion_policy: 'approval-required' } }), ok: { status: 200 } },
  { scope: 'org', minRole: 'owner', method: 'GET', path: `/api/orgs/${ORG_A}/promotions`, ok: { status: 200 } },
  { scope: 'org', minRole: 'owner', method: 'POST', path: `/api/orgs/${ORG_A}/promotions/999/approve`, req: () => ({ json: {} }), ok: { status: 404, error: 'promotion request not found' } },
  { scope: 'org', minRole: 'owner', method: 'POST', path: `/api/orgs/${ORG_A}/promotions/999/reject`, req: () => ({ json: {} }), ok: { status: 404, error: 'promotion request not found' } },
];

const RANK = { viewer: 1, editor: 2, owner: 3 };
const AT_THRESHOLD = { viewer: 'viewer', editor: 'editor', owner: 'owner' };
const NOT_FOUND_BODY = { project: 'project not found', org: 'organization not found' };
const label = (r) => `${r.method} ${r.path}`;

describe('role thresholds across the full route table (010-003 AC1)', () => {
  it('every route below threshold refuses members with the verbatim role error', async () => {
    for (const route of ROUTES) {
      for (const principal of ['viewer', 'editor']) {
        if (RANK[principal] >= RANK[route.minRole]) continue;
        const res = await call(route.method, route.path, principal, route.req?.());
        expect(res.status, `${label(route)} as ${principal}`).toBe(403);
        expect(await res.json(), `${label(route)} as ${principal}`)
          .toEqual({ error: `requires ${route.minRole} role` });
      }
    }
  });

  it('every route passes its at-threshold principal through the guard', async () => {
    for (const route of ROUTES) {
      const principal = AT_THRESHOLD[route.minRole];
      const res = await call(route.method, route.path, principal, route.req?.());
      if (route.sse) {
        expect(res.status, label(route)).toBe(200);
        expect(res.headers.get('content-type'), label(route)).toContain('text/event-stream');
        await res.body?.cancel();
        continue;
      }
      expect(res.status, label(route)).toBe(route.ok.status);
      if (route.ok.error) {
        expect((await res.json()).error, label(route)).toBe(route.ok.error);
      } else {
        await res.arrayBuffer(); // drain
      }
    }
  });
});

describe('cross-tenant and super-admin non-leak (011-001 invariant)', () => {
  it.each([['stranger'], ['superadmin']])(
    '%s gets a non-leaking 404 on every org-A route', async (principal) => {
      for (const route of ROUTES) {
        const res = await call(route.method, route.path, principal, route.req?.());
        expect(res.status, `${label(route)} as ${principal}`).toBe(404);
        expect(await res.json(), `${label(route)} as ${principal}`)
          .toEqual({ error: NOT_FOUND_BODY[route.scope] });
      }
    },
  );

  it('the super-admin has zero orgs of their own', async () => {
    const res = await call('GET', '/api/orgs', 'superadmin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgs: [] });
  });

  it('the stranger sees only org B content', async () => {
    const orgs = await (await call('GET', '/api/orgs', 'stranger')).json();
    expect(orgs.orgs).toMatchObject([{ id: ORG_B, role: 'owner', status: 'active' }]);
    const projects = await (await call('GET', '/api/projects', 'stranger')).json();
    expect(projects.projects.map((p) => p.id)).toEqual([PROJECT_B]);
  });
});

describe('suspension refuses everything at once (011-001)', () => {
  beforeAll(() => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG_A}`);
  });
  afterAll(() => {
    querySync(`UPDATE organizations SET status = 'active' WHERE id = ${ORG_A}`);
  });

  it('every guarded route 403s the org owner with the verbatim suspension error', async () => {
    for (const route of ROUTES) {
      const res = await call(route.method, route.path, 'owner', route.req?.());
      expect(res.status, label(route)).toBe(403);
      expect(await res.json(), label(route)).toEqual({ error: 'organization suspended' });
    }
  });

  it('non-members still get 404, not a suspension hint', async () => {
    const res = await call('GET', `/api/orgs/${ORG_A}/library`, 'stranger');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'organization not found' });
  });

  it('GET /api/orgs still lists the suspended org with its status', async () => {
    const { orgs } = await (await call('GET', '/api/orgs', 'owner')).json();
    expect(orgs.find((o) => o.id === ORG_A)).toMatchObject({ status: 'suspended' });
  });

  it('GET /api/projects excludes projects of the suspended org (I8)', async () => {
    const { projects } = await (await call('GET', '/api/projects', 'owner')).json();
    expect(projects.some((p) => p.org_id === ORG_A)).toBe(false);
  });

  it('the super-admin /api/admin surface ignores suspension — that is how it ends', async () => {
    const res = await call('PATCH', `/api/admin/orgs/${ORG_A}`, 'superadmin', {
      json: { status: 'suspended' }, // idempotent write proves the door stays open
    });
    expect(res.status).toBe(200);
    expect((await res.json()).org).toMatchObject({ id: ORG_A, status: 'suspended' });
  });
});

describe('super-admin lifecycle surface (011-001)', () => {
  const SA_ROUTES = [
    ['POST', '/api/orgs', { json: { name: 'Nope' } }],
    ['GET', '/api/admin/orgs', undefined],
    ['PATCH', `/api/admin/orgs/${ORG_A}`, { json: { name: 'Nope' } }],
  ];

  it('every non-super-admin principal gets the verbatim 403 — role is irrelevant', async () => {
    for (const principal of ['owner', 'editor', 'viewer', 'stranger']) {
      for (const [method, path, req] of SA_ROUTES) {
        const res = await call(method, path, principal, req);
        expect(res.status, `${method} ${path} as ${principal}`).toBe(403);
        expect(await res.json(), `${method} ${path} as ${principal}`)
          .toEqual({ error: 'super-admin required' });
      }
    }
  });

  it('SA creates an ownerless org and stays a stranger to its content', async () => {
    const res = await call('POST', '/api/orgs', 'superadmin', {
      json: { name: 'Matrix SA Org' },
    });
    expect(res.status).toBe(201);
    const { org, member } = await res.json();
    expect(member).toBe(false);
    expect(org.role).toBeUndefined();
    // The creator holds no membership: content routes 404, non-leaking.
    const library = await call('GET', `/api/orgs/${org.id}/library`, 'superadmin');
    expect(library.status).toBe(404);
    expect(await library.json()).toEqual({ error: 'organization not found' });
    // But the /api/admin surface sees it, with a zero member count.
    const { orgs } = await (await call('GET', '/api/admin/orgs', 'superadmin')).json();
    expect(orgs.find((o) => o.id === org.id)).toMatchObject({ member_count: 0, status: 'active' });
  });
});

describe('shipped behavior changes (wave-4 contract items 3/5/6)', () => {
  it('GET /api/agent/jobs and /pending require projectId (400 without)', async () => {
    for (const path of ['/api/agent/jobs', '/api/agent/pending']) {
      const res = await call('GET', path, 'owner');
      expect(res.status, path).toBe(400);
      expect((await res.json()).error, path).toBe('projectId query parameter is required');
    }
  });

  it('GET /api/orgs/:id/projects 400s a non-numeric id', async () => {
    const res = await call('GET', '/api/orgs/abc/projects', 'owner');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid organization id' });
  });

  it('POST /api/projects into a non-member org 404s organization not found', async () => {
    const res = await call('POST', '/api/projects', 'owner', {
      json: { name: 'Sneaky', orgId: ORG_B },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'organization not found' });
  });
});

describe('promotion policy branch (011-004)', () => {
  it('editor suggestion is 202 pending; a duplicate returns the SAME request with 200', async () => {
    const first = await call('POST', `/api/projects/${PROJECT_A}/files/promote`, 'editor', {
      json: { path: 'draft/dup-check.md', note: 'please share' },
    });
    expect(first.status).toBe(202);
    const { request } = await first.json();
    expect(request).toMatchObject({ path: 'draft/dup-check.md', status: 'pending' });
    // Nothing was copied or ingested for a pending suggestion.
    expect(querySync('SELECT COUNT(*) AS n FROM org_documents').rows[0].n).toBe(
      // the library-upload sweep stored exactly one document earlier
      1,
    );

    const dup = await call('POST', `/api/projects/${PROJECT_A}/files/promote`, 'editor', {
      json: { path: 'draft/dup-check.md' },
    });
    expect(dup.status).toBe(200);
    expect((await dup.json()).request.id).toBe(request.id);
  });

  it('owners bypass the queue: the direct path reads the file immediately', async () => {
    // Missing file → 404 from the read, proving the owner took the direct
    // copy path (a queued suggestion never touches the file).
    const missing = await call('POST', `/api/projects/${PROJECT_A}/files/promote`, 'owner', {
      json: { path: 'draft/not-there.md' },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('not_found');

    const direct = await call('POST', `/api/projects/${PROJECT_A}/files/promote`, 'owner', {
      json: { path: 'draft/main.md' },
    });
    expect(direct.status).toBe(201);
    expect((await direct.json()).document).toMatchObject({ source: 'project-promotion' });
  });
});
