// Issue #67: agent prompt view + org additions routes. Real in-memory SQLite
// (role guards are SQL), real session cookies — the org-admin.test.js harness.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const RIVAL_ORG = 2;
const OWNER = 1;
const EDITOR = 2;
const VIEWER = 3;
const STRANGER = 4;

let config; let querySync;
let createSession;
let MAX_ADDITION_CHARS;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';

  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  ({ createSession } = await import('../db/auth.js'));
  ({ MAX_ADDITION_CHARS } = await import('../db/org-agent-prompts.js'));
  const { session } = await import('../session.js');
  const { default: agentPromptsRouter } = await import('./agent-prompts.js');
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));

  const app = express();
  app.use(express.json());
  app.use(session);
  app.use(agentPromptsRouter);
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  config.auth.mode = 'dev';
  config.auth.sessionSecret = '';
  await new Promise((ok) => server.close(ok));
});

beforeEach(() => {
  for (const table of ['auth_events', 'org_agent_prompts', 'sessions', 'memberships', 'users', 'organizations', 'agent_tools', 'agents']) {
    querySync(`DELETE FROM ${table}`);
  }
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab'), (${RIVAL_ORG}, 'Rival', 'rival')`);
  querySync(`INSERT INTO users (id, email) VALUES
    (${OWNER}, 'owner@lab.org'), (${EDITOR}, 'editor@lab.org'),
    (${VIEWER}, 'viewer@lab.org'), (${STRANGER}, 'stranger@rival.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES
    (${OWNER}, ${ORG}, 'owner'), (${EDITOR}, ${ORG}, 'editor'),
    (${VIEWER}, ${ORG}, 'viewer'), (${STRANGER}, ${RIVAL_ORG}, 'owner')`);
  // Seed-shaped agent rows: the view joins the live agents table
  querySync(`INSERT INTO agents (id, slug, name, description, system_prompt, model) VALUES
    (1, 'pm', 'PM', 'Coordinates', 'You are the PM.', 'claude-opus-4-8'),
    (2, 'analyst', 'Analyst', 'Analyzes data', 'You are the analyst.', 'claude-sonnet-4-6')`);
});

async function cookieFor(userId) {
  const { cookieValue } = await createSession(userId);
  return cookieValue;
}

const api = (method, path, { cookie, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: `kuhn_session=${encodeURIComponent(cookie)}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const eventTypes = () =>
  querySync('SELECT type FROM auth_events ORDER BY id').rows.map((r) => r.type);

describe('GET /api/orgs/:orgId/agent-prompts', () => {
  it('returns every agent with base prompt and this org additions for a viewer', async () => {
    querySync(`INSERT INTO org_agent_prompts (org_id, agent_slug, addition, updated_by)
               VALUES (${ORG}, 'analyst', 'No PHI queries.', ${OWNER}),
                      (${RIVAL_ORG}, 'analyst', 'Rival rule', ${STRANGER})`);
    const res = await api('GET', `/api/orgs/${ORG}/agent-prompts`, { cookie: await cookieFor(VIEWER) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.max_addition_chars).toBe(MAX_ADDITION_CHARS);
    expect(body.agents.map((a) => a.slug)).toEqual(['pm', 'analyst']); // seed (id) order
    const analyst = body.agents.find((a) => a.slug === 'analyst');
    expect(analyst.system_prompt).toBe('You are the analyst.');
    expect(analyst.model).toBe('claude-sonnet-4-6');
    // Only THIS org's addition — never the rival's
    expect(analyst.addition).toMatchObject({ text: 'No PHI queries.', updated_by_email: 'owner@lab.org' });
    expect(body.agents.find((a) => a.slug === 'pm').addition).toBeNull();
  });

  it('is non-leaking for non-members and unknown orgs', async () => {
    const asStranger = await api('GET', `/api/orgs/${ORG}/agent-prompts`, { cookie: await cookieFor(STRANGER) });
    expect(asStranger.status).toBe(404);
    const unknown = await api('GET', '/api/orgs/999/agent-prompts', { cookie: await cookieFor(OWNER) });
    expect(unknown.status).toBe(404);
  });
});

describe('PUT /api/orgs/:orgId/agent-prompts/:slug', () => {
  it('lets an owner set and clear an addition, with audit events', async () => {
    const cookie = await cookieFor(OWNER);
    const set = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, {
      cookie, body: { addition: 'Only use the deidentified schema.' },
    });
    expect(set.status).toBe(200);
    expect((await set.json()).addition).toMatchObject({
      text: 'Only use the deidentified schema.',
      updated_by_email: 'owner@lab.org',
    });

    const clear = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, { cookie, body: { addition: '' } });
    expect(clear.status).toBe(200);
    expect((await clear.json()).addition).toBeNull();
    expect(querySync('SELECT COUNT(*) AS n FROM org_agent_prompts').rows[0].n).toBe(0);
    expect(eventTypes()).toEqual(['agent_prompt.updated', 'agent_prompt.cleared']);
  });

  it('refuses editors and viewers with 403', async () => {
    for (const user of [EDITOR, VIEWER]) {
      const res = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, {
        cookie: await cookieFor(user), body: { addition: 'x' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('requires owner role');
    }
  });

  it('404s an unknown agent slug and 400s bad input', async () => {
    const cookie = await cookieFor(OWNER);
    const unknown = await api('PUT', `/api/orgs/${ORG}/agent-prompts/nope`, { cookie, body: { addition: 'x' } });
    expect(unknown.status).toBe(404);

    const overCap = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, {
      cookie, body: { addition: 'x'.repeat(MAX_ADDITION_CHARS + 1) },
    });
    expect(overCap.status).toBe(400);
    expect(await overCap.json()).toMatchObject({ field: 'addition' });

    const notString = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, { cookie, body: {} });
    expect(notString.status).toBe(400);
  });

  it('refuses writes in a suspended org', async () => {
    querySync(`UPDATE organizations SET status = 'suspended' WHERE id = ${ORG}`);
    const res = await api('PUT', `/api/orgs/${ORG}/agent-prompts/analyst`, {
      cookie: await cookieFor(OWNER), body: { addition: 'x' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('organization suspended');
  });
});
