// Model profile + routing routes (issues #107/#111/#112): owner gating,
// profile CRUD with field-level 400s, deployment profiles read-only, the
// route PUT with egress-boundary reporting and advisory warnings, and the
// probe endpoint (probe mocked). Real in-memory SQLite behind the real
// session middleware.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

process.env.KUHN_SQLITE_PATH = ':memory:';

const probeState = vi.hoisted(() => ({ result: null, calls: [] }));
vi.mock('../agents/model-probe.js', () => ({
  probeProfile: vi.fn(async (orgId, profile) => {
    probeState.calls.push({ orgId, slug: profile.slug });
    return probeState.result;
  }),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = 1;
const OTHER_ORG = 2;
const OWNER = 1;
const EDITOR = 2;
const STRANGER = 3;

let config; let exec; let querySync; let createSession; let setOrgSecret;
let server; let base;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  config.auth.mode = 'magic-link';
  config.auth.sessionSecret = 'test-secret';
  ({ exec, querySync } = await import('../db.js'));
  ({ createSession } = await import('../db/auth.js'));
  ({ setOrgSecret } = await import('../db/org-secrets.js'));
  const { session } = await import('../session.js');
  const { default: router } = await import('./model-profiles.js');
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
  probeState.result = { ok: true, provider: 'openai', model: 'gpt-5-mini', latency_ms: 12 };
  probeState.calls = [];
  for (const t of ['auth_events', 'agent_model_routes', 'model_profiles', 'org_secrets', 'agent_tools', 'tools', 'agents', 'sessions', 'memberships', 'users', 'organizations']) querySync(`DELETE FROM ${t}`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab'), (${OTHER_ORG}, 'Other', 'other')`);
  querySync(`INSERT INTO users (id, email) VALUES (${OWNER}, 'owner@lab.org'), (${EDITOR}, 'editor@lab.org'), (${STRANGER}, 'x@other.org')`);
  querySync(`INSERT INTO memberships (user_id, org_id, role) VALUES (${OWNER}, ${ORG}, 'owner'), (${EDITOR}, ${ORG}, 'editor'), (${STRANGER}, ${OTHER_ORG}, 'owner')`);
  querySync(`INSERT INTO agents (id, slug, name, system_prompt, model) VALUES (1, 'pm', 'PM', 'x', 'claude-opus-4-8'), (2, 'ra', 'RA', 'x', 'claude-haiku-4-5')`);
  querySync(`INSERT INTO tools (id, slug, name, description, parameter_schema) VALUES (1, 'web_search', 'Web', 'w', '{}')`);
  querySync('INSERT INTO agent_tools (agent_id, tool_id) VALUES (2, 1)');
  setOrgSecret(ORG, 'openai-key', 'sk-value');
  config.agentRuntime = { kind: 'claude', pi: { provider: '', model: '', baseUrl: '', apiKeyEnv: '' }, allowPrivateEndpoints: true };
  config.agent = { ...config.agent, model: undefined, modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 } };
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

const PROFILE = { slug: 'gpt-mini', name: 'GPT mini', provider: 'openai', model_id: 'gpt-5-mini', credential_secret: 'openai-key', cost_weight: 2 };

describe('guards', () => {
  const routes = [
    ['GET', `/api/orgs/${ORG}/model-profiles`],
    ['POST', `/api/orgs/${ORG}/model-profiles`, PROFILE],
    ['PATCH', `/api/orgs/${ORG}/model-profiles/gpt-mini`, { name: 'x' }],
    ['DELETE', `/api/orgs/${ORG}/model-profiles/gpt-mini`],
    ['POST', `/api/orgs/${ORG}/model-profiles/gpt-mini/test`],
    ['GET', `/api/orgs/${ORG}/model-routes`],
    ['PUT', `/api/orgs/${ORG}/model-routes/ra`, { routes: [] }],
  ];

  it('editor → 403, non-member → 404 on every route', async () => {
    for (const [method, path, body] of routes) {
      expect((await api(method, path, EDITOR, body)).status, `${method} ${path} editor`).toBe(403);
      expect((await api(method, path, STRANGER, body)).status, `${method} ${path} stranger`).toBe(404);
    }
    expect(querySync('SELECT COUNT(*) AS n FROM model_profiles').rows[0].n).toBe(0);
  });
});

describe('profiles', () => {
  it('lists deployment profiles read-only and creates/patches/deletes org ones with audit rows', async () => {
    let res = await api('GET', `/api/orgs/${ORG}/model-profiles`, OWNER);
    expect(res.status).toBe(200);
    const initial = (await res.json()).profiles;
    expect(initial.map((p) => p.slug)).toEqual(['deployment-claude-opus-4-8', 'deployment-claude-haiku-4-5']);
    expect(initial.every((p) => p.managed)).toBe(true);

    res = await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, PROFILE);
    expect(res.status).toBe(201);
    const { profile } = await res.json();
    expect(profile).toMatchObject({ slug: 'gpt-mini', endpoint: 'https://api.openai.com/v1', credential: { kind: 'secret', secret: 'openai-key' }, managed: false });
    expect(JSON.stringify(profile)).not.toContain('sk-value');

    res = await api('PATCH', `/api/orgs/${ORG}/model-profiles/gpt-mini`, OWNER, { name: 'Renamed', data_policy: 'no training' });
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ name: 'Renamed', data_policy: 'no training' });

    expect((await api('PATCH', `/api/orgs/${ORG}/model-profiles/deployment-claude-opus-4-8`, OWNER, { name: 'x' })).status).toBe(404);
    expect((await api('DELETE', `/api/orgs/${ORG}/model-profiles/deployment-claude-opus-4-8`, OWNER)).status).toBe(404);

    expect((await api('DELETE', `/api/orgs/${ORG}/model-profiles/gpt-mini`, OWNER)).status).toBe(204);
    expect((await api('DELETE', `/api/orgs/${ORG}/model-profiles/gpt-mini`, OWNER)).status).toBe(404);

    const events = querySync('SELECT type, meta FROM auth_events ORDER BY id').rows;
    expect(events.map((e) => e.type)).toEqual(['model_profile.saved', 'model_profile.saved', 'model_profile.deleted']);
    expect(events.map((e) => e.meta).join('')).not.toContain('sk-value');
  });

  it('answers catalog lookups for known and unknown model ids', async () => {
    let res = await api('GET', `/api/orgs/${ORG}/model-profiles/catalog?provider=openai&model_id=gpt-5-mini`, OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ known: true, name: 'GPT-5 Mini', suggested_cost_weight: 0.25, capabilities: { contextWindow: 400000, reasoning: true } });
    res = await api('GET', `/api/orgs/${ORG}/model-profiles/catalog?provider=openai-compatible&model_id=qwen`, OWNER);
    expect(await res.json()).toMatchObject({ known: false, capabilities: null });
    expect((await api('GET', `/api/orgs/${ORG}/model-profiles/catalog?provider=mistral&model_id=x`, OWNER)).status).toBe(400);
    expect((await api('GET', `/api/orgs/${ORG}/model-profiles/catalog?provider=openai&model_id=x`, EDITOR)).status).toBe(403);
  });

  it('maps validation failures to 400 with the field', async () => {
    let res = await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, { ...PROFILE, credential_secret: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'credential_secret' });
    res = await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, { ...PROFILE, provider: 'openai-compatible', base_url: 'http://public.example.org/v1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'base_url', error: expect.stringMatching(/https/) });
    res = await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, PROFILE);
    expect(res.status).toBe(201);
    res = await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, PROFILE);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'slug' });
  });

  it('probes a profile (org or deployment) and audits the outcome; 404 for unknown slugs', async () => {
    await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, PROFILE);
    let res = await api('POST', `/api/orgs/${ORG}/model-profiles/gpt-mini/test`, OWNER);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual(probeState.result);
    res = await api('POST', `/api/orgs/${ORG}/model-profiles/deployment-claude-haiku-4-5/test`, OWNER);
    expect(res.status).toBe(200);
    expect(probeState.calls).toEqual([{ orgId: ORG, slug: 'gpt-mini' }, { orgId: ORG, slug: 'deployment-claude-haiku-4-5' }]);
    expect((await api('POST', `/api/orgs/${ORG}/model-profiles/ghost/test`, OWNER)).status).toBe(404);
    const tested = querySync("SELECT meta FROM auth_events WHERE type = 'model_profile.tested'").rows;
    expect(tested).toHaveLength(2);
    expect(JSON.parse(tested[0].meta)).toMatchObject({ slug: 'gpt-mini', ok: true });
  });
});

describe('routes', () => {
  beforeEach(async () => {
    await api('POST', `/api/orgs/${ORG}/model-profiles`, OWNER, PROFILE);
  });

  it('GET lists every agent with its default, current routes, and warnings', async () => {
    const res = await api('GET', `/api/orgs/${ORG}/model-routes`, OWNER);
    expect(res.status).toBe(200);
    const { agents } = await res.json();
    expect(agents).toEqual([
      { slug: 'pm', name: 'PM', tools: [], default_profile: 'deployment-claude-opus-4-8', routes: [], warnings: [] },
      { slug: 'ra', name: 'RA', tools: ['web_search'], default_profile: 'deployment-claude-haiku-4-5', routes: [], warnings: [] },
    ]);
  });

  it('PUT replaces a role\'s list, reports the egress boundary change and web-search degradation', async () => {
    let res = await api('PUT', `/api/orgs/${ORG}/model-routes/ra`, OWNER, {
      routes: [{ profile_slug: 'gpt-mini', difficulty: 0.5 }, { profile_slug: 'deployment-claude-opus-4-8', difficulty: 1 }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routes).toEqual([{ profile_slug: 'gpt-mini', difficulty: 0.5 }, { profile_slug: 'deployment-claude-opus-4-8', difficulty: 1 }]);
    expect(body.egress).toEqual({ before: ['api.anthropic.com'], after: ['api.openai.com', 'api.anthropic.com'], added: ['api.openai.com'] });
    expect(body.warnings).toEqual([{ profile_slug: 'gpt-mini', message: expect.stringMatching(/web_search.*Anthropic/) }]);

    res = await api('GET', `/api/orgs/${ORG}/model-routes`, OWNER);
    const ra = (await res.json()).agents.find((a) => a.slug === 'ra');
    expect(ra.routes).toHaveLength(2);
    expect(ra.warnings).toHaveLength(1);

    // Revert: no boundary added, list empty.
    res = await api('PUT', `/api/orgs/${ORG}/model-routes/ra`, OWNER, { routes: [] });
    expect((await res.json())).toMatchObject({ routes: [], egress: { added: [] } });
    const saved = querySync("SELECT meta FROM auth_events WHERE type = 'model_route.saved'").rows;
    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0].meta)).toMatchObject({ agent: 'ra', routes: ['gpt-mini@0.5', 'deployment-claude-opus-4-8@1'] });
  });

  it('rejects bad lists with 400 + field, unknown agents with 404, and other orgs\' profiles', async () => {
    let res = await api('PUT', `/api/orgs/${ORG}/model-routes/ra`, OWNER, { routes: [{ profile_slug: 'gpt-mini', difficulty: 3 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'routes[0]' });
    expect((await api('PUT', `/api/orgs/${ORG}/model-routes/ghost`, OWNER, { routes: [] })).status).toBe(404);
    setOrgSecret(OTHER_ORG, 'k', 'v');
    await api('POST', `/api/orgs/${OTHER_ORG}/model-profiles`, STRANGER, { ...PROFILE, slug: 'theirs', credential_secret: 'k' });
    res = await api('PUT', `/api/orgs/${ORG}/model-routes/ra`, OWNER, { routes: [{ profile_slug: 'theirs', difficulty: 1 }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no profile named 'theirs'/);
  });
});
