// Org token-budget routes (issue #110, parts 3–4): owner gating, member/
// project resolution inside the org, override + reset, and the report.
// Real in-memory SQLite behind the real session middleware.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const OTHER_ORG = 2;
const OWNER = 1;
const EDITOR = 2;
const STRANGER = 3;
const P1 = 10;
const P_OTHER = 20;

let config; let exec; let querySync; let createSession;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  ({ exec, querySync } = await import('../db.js'));
  ({ createSession } = await import('../db/auth.js'));
  const { session } = await import('../session.js');
  const { default: router } = await import('./org-budgets.js');
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  const app = express();
  app.use(express.json());
  app.use(session);
  app.use(router);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = 'dev';
  config.auth.sessionSecret = '';
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  for (const t of ['auth_events', 'jobs', 'org_budgets', 'sessions', 'memberships', 'projects', 'users', 'organizations']) querySync(`DELETE FROM ${t}`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab'), (${OTHER_ORG}, 'Other', 'other')`);
  querySync(`INSERT INTO users (id, email) VALUES (${OWNER}, 'owner@lab.org'), (${EDITOR}, 'editor@lab.org'), (${STRANGER}, 'x@other.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${OWNER}, ${ORG}, 'owner'), (${EDITOR}, ${ORG}, 'editor'), (${STRANGER}, ${OTHER_ORG}, 'owner')`);
  querySync(`INSERT INTO projects (id, org_id, name, project_type) VALUES (${P1}, ${ORG}, 'One', 'manuscript'), (${P_OTHER}, ${OTHER_ORG}, 'Elsewhere', 'manuscript')`);
});

async function cookieFor(userId) {
  const { cookieValue } = await createSession(userId);
  return cookieValue;
}

const api = async (method, path, userId, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Cookie: `kuhn_session=${encodeURIComponent(await cookieFor(userId))}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe('guards', () => {
  const routes = [
    ['GET', `/api/orgs/${ORG}/budgets`],
    ['PUT', `/api/orgs/${ORG}/budgets/user/${EDITOR}`, { limit_tokens: 5 }],
    ['POST', `/api/orgs/${ORG}/budgets/user/${EDITOR}/reset`],
  ];

  it('editor → 403, non-member → 404 on every route', async () => {
    for (const [method, path, body] of routes) {
      expect((await api(method, path, EDITOR, body)).status).toBe(403);
      expect((await api(method, path, STRANGER, body)).status).toBe(404);
    }
    expect(querySync('SELECT COUNT(*) AS n FROM org_budgets').rows[0].n).toBe(0);
  });
});

describe('report', () => {
  it('returns defaults, the window, and per-member / per-project rows', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/budgets`, OWNER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ user_token_budget: 0, project_token_budget: 0, budget_period: 'month' });
    expect(body.users.map((u) => u.user_id)).toEqual([OWNER, EDITOR]);
    expect(body.projects).toEqual([{ project_id: P1, name: 'One', override: null, limit: null, used: 0, reset_at: null }]);
  });
});

describe('overrides and reset', () => {
  it('PUT sets, clears, and validates an override; the target must be the org\'s', async () => {
    let res = await api('PUT', `/api/orgs/${ORG}/budgets/user/${EDITOR}`, OWNER, { limit_tokens: 250000 });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.budget).toMatchObject({ org_id: ORG, scope: 'user', scope_id: EDITOR, limit_tokens: 250000 });
    expect(body.report.users.find((u) => u.user_id === EDITOR)).toMatchObject({ override: 250000, limit: 250000 });

    res = await api('PUT', `/api/orgs/${ORG}/budgets/user/${EDITOR}`, OWNER, { limit_tokens: null });
    expect((await res.json()).report.users.find((u) => u.user_id === EDITOR)).toMatchObject({ override: null, limit: null });

    for (const [bad, field] of [[{ limit_tokens: -1 }, 'limit_tokens'], [{ limit_tokens: 'lots' }, 'limit_tokens'], [{}, 'limit_tokens']]) {
      res = await api('PUT', `/api/orgs/${ORG}/budgets/project/${P1}`, OWNER, bad);
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe(field);
    }
    // A stranger to the org, or another org's project, is not a valid target.
    expect((await api('PUT', `/api/orgs/${ORG}/budgets/user/${STRANGER}`, OWNER, { limit_tokens: 1 })).status).toBe(404);
    expect((await api('PUT', `/api/orgs/${ORG}/budgets/project/${P_OTHER}`, OWNER, { limit_tokens: 1 })).status).toBe(404);
    expect((await api('PUT', `/api/orgs/${ORG}/budgets/team/${P1}`, OWNER, { limit_tokens: 1 })).status).toBe(400);
    expect((await api('PUT', `/api/orgs/${ORG}/budgets/project/abc`, OWNER, { limit_tokens: 1 })).status).toBe(400);
    expect(querySync('SELECT COUNT(*) AS n FROM org_budgets').rows[0].n).toBe(1);
  });

  it('POST reset stamps reset_at, zeroes usage in the report, and is audited', async () => {
    querySync(
      `INSERT INTO jobs (project_id, user_id, role, input, status, weighted_tokens)
       VALUES (${P1}, ${EDITOR}, 'writer', 'x', 'done', 700)`,
    );
    let body = await (await api('GET', `/api/orgs/${ORG}/budgets`, OWNER)).json();
    expect(body.users.find((u) => u.user_id === EDITOR).used).toBe(700);
    expect(body.projects[0].used).toBe(700);

    const res = await api('POST', `/api/orgs/${ORG}/budgets/user/${EDITOR}/reset`, OWNER);
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.budget).toMatchObject({ scope: 'user', scope_id: EDITOR, reset_by: OWNER });
    expect(body.budget.reset_at).toBeTruthy();
    const editor = body.report.users.find((u) => u.user_id === EDITOR);
    expect(editor).toMatchObject({ used: 0, reset_at: body.budget.reset_at });
    // The project ledger is separate — untouched by a user reset.
    expect(body.report.projects[0].used).toBe(700);
    expect(querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type)).toEqual(['org.budget_reset']);
  });
});
