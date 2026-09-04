// Model profiles + per-role routes (issues #107/#111/#112): deployment
// defaults, validation (base-URL policy, credential references, capabilities),
// CRUD, and the route store — real in-memory SQLite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let querySync; let profiles; let secrets;

const ORG = 1;
const OTHER_ORG = 2;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  profiles = await import('./model-profiles.js');
  secrets = await import('./org-secrets.js');
});

beforeEach(() => {
  for (const t of ['agent_model_routes', 'model_profiles', 'org_secrets', 'agents', 'users', 'organizations']) querySync(`DELETE FROM ${t}`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab'), (${OTHER_ORG}, 'Other', 'other')`);
  querySync("INSERT INTO users (id, email) VALUES (1, 'owner@lab.org')");
  querySync(`INSERT INTO agents (slug, name, system_prompt, model) VALUES
    ('pm', 'PM', 'x', 'claude-opus-4-8'), ('writer', 'Writer', 'x', 'claude-opus-4-8'),
    ('ra', 'RA', 'x', 'claude-haiku-4-5'), ('advisor', 'Advisor', 'x', 'claude-sonnet-4-6')`);
  secrets.setOrgSecret(ORG, 'openai-key', 'sk-test-value');
  secrets.setOrgSecret(OTHER_ORG, 'stranger-key', 'sk-stranger');
  config.agentRuntime = {
    kind: 'claude', pi: { provider: '', model: '', baseUrl: '', apiKeyEnv: '' }, allowPrivateEndpoints: true,
  };
  config.agent = { ...config.agent, model: undefined, modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 }, contextWindow: 200000 };
});

const valid = (overrides = {}) => ({
  slug: 'gpt-mini', name: 'GPT mini', provider: 'openai', model_id: 'gpt-5-mini',
  credential_secret: 'openai-key', cost_weight: 2, ...overrides,
});

describe('deployment profiles', () => {
  it('derives one Anthropic profile per distinct seeded agent model, weighted by tier', () => {
    const list = profiles.deploymentProfiles();
    expect(list.map((p) => p.slug)).toEqual([
      'deployment-claude-opus-4-8', 'deployment-claude-haiku-4-5', 'deployment-claude-sonnet-4-6',
    ]);
    expect(list[0]).toMatchObject({
      provider: 'anthropic', model_id: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com',
      credential: { kind: 'deployment' }, cost_weight: 5, managed: true, enabled: true,
    });
    expect(list[1].cost_weight).toBe(1);
  });

  it('adds the Pi preview when KUHN_PI_* is configured and makes it the default in pi mode', () => {
    config.agentRuntime = {
      kind: 'pi', pi: { provider: 'openrouter', model: 'openai/gpt-oss-20b', baseUrl: '', apiKeyEnv: '' },
    };
    const pi = profiles.deploymentProfiles().find((p) => p.slug === profiles.PI_PREVIEW_SLUG);
    expect(pi).toMatchObject({
      provider: 'openrouter', model_id: 'openai/gpt-oss-20b', endpoint: 'https://openrouter.ai/api/v1',
      credential: { kind: 'deployment', env: 'OPENROUTER_API_KEY' },
    });
    const fallback = profiles.deploymentDefaultProfile({ slug: 'ra', model: 'claude-haiku-4-5' });
    expect(fallback.slug).toBe(profiles.PI_PREVIEW_SLUG);
    // The role's seeded tier still meters the budget (pre-#107 preview behavior).
    expect(fallback.cost_weight).toBe(1);
  });

  it('defaults a role to its seeded model on the deployment key in claude mode', () => {
    expect(profiles.deploymentDefaultProfile({ slug: 'ra', model: 'claude-haiku-4-5' })).toMatchObject({
      slug: 'deployment-claude-haiku-4-5', provider: 'anthropic', model_id: 'claude-haiku-4-5',
    });
    expect(profiles.deploymentDefaultProfile({ slug: 'x', model: null })).toMatchObject({
      slug: 'deployment-default', model_id: null,
    });
  });

  it('is read-only: update and delete refuse deployment slugs', () => {
    expect(profiles.updateProfile(ORG, 'deployment-claude-opus-4-8', { name: 'x' })).toBeNull();
    expect(profiles.deleteProfile(ORG, 'deployment-claude-opus-4-8')).toBe(false);
  });
});

describe('validateBaseUrl policy', () => {
  it('accepts https public hosts and normalizes the trailing slash', () => {
    expect(profiles.validateBaseUrl('https://llm.example.org/v1/')).toBe('https://llm.example.org/v1');
  });

  it.each([
    ['https://user:pw@llm.example.org/v1', /credentials/],
    ['https://llm.example.org/v1?x=1', /credentials, query parameters/],
    ['ftp://llm.example.org/v1', /http or https/],
    ['not a url', /absolute http/],
    ['http://llm.example.org/v1', /must use https unless/],
    ['', /required/],
  ])('rejects %s', (url, message) => {
    expect(() => profiles.validateBaseUrl(url)).toThrow(message);
  });

  it('allows private/loopback hosts (http too) only when the operator enabled them', () => {
    expect(profiles.validateBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1');
    expect(profiles.validateBaseUrl('http://vllm.internal:8000/v1')).toBe('http://vllm.internal:8000/v1');
    config.agentRuntime.allowPrivateEndpoints = false;
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.2', '172.20.0.1', '169.254.169.254', '[::1]']) {
      expect(() => profiles.validateBaseUrl(`http://${host}:8000/v1`)).toThrow(/KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS/);
      expect(() => profiles.validateBaseUrl(`https://${host}:8000/v1`)).toThrow(/KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS/);
    }
    expect(profiles.validateBaseUrl('https://llm.example.org/v1')).toBe('https://llm.example.org/v1');
  });
});

describe('org profiles', () => {
  it('creates, lists after the deployment profiles, and reads back without the secret value', () => {
    const created = profiles.createProfile(ORG, valid(), { createdBy: 1 });
    expect(created).toMatchObject({
      slug: 'gpt-mini', provider: 'openai', model_id: 'gpt-5-mini', endpoint: 'https://api.openai.com/v1',
      credential: { kind: 'secret', secret: 'openai-key' }, cost_weight: 2, enabled: true, managed: false,
      // gpt-5-mini is in the built-in catalog: capabilities come from it,
      // nothing is stored as an override.
      capabilities: { reasoning: true, input: ['text', 'image'], contextWindow: 400000, tools: true },
      capability_overrides: {},
      catalog_known: true,
    });
    expect(JSON.stringify(created)).not.toContain('sk-test-value');
    const list = profiles.listProfiles(ORG);
    expect(list.at(-1).slug).toBe('gpt-mini');
    expect(list.filter((p) => p.managed)).toHaveLength(3);
    expect(profiles.getProfile(ORG, 'gpt-mini')).toMatchObject({ slug: 'gpt-mini' });
    expect(profiles.getProfile(OTHER_ORG, 'gpt-mini')).toBeNull();
  });

  it.each([
    [{ slug: 'Bad Slug' }, 'slug'],
    [{ slug: 'deployment-x' }, 'slug'],
    [{ name: '' }, 'name'],
    [{ provider: 'mistral' }, 'provider'],
    [{ model_id: 'has space' }, 'model_id'],
    [{ model_id: '' }, 'model_id'],
    [{ base_url: 'https://x.example/v1' }, 'base_url'],
    [{ credential_secret: null }, 'credential_secret'],
    [{ credential_secret: 'missing-key' }, 'credential_secret'],
    [{ credential_secret: 'stranger-key' }, 'credential_secret'],
    [{ capabilities: { tools: 'yes' } }, 'capabilities'],
    [{ capabilities: { contextWindow: 10 } }, 'capabilities'],
    [{ capabilities: { input: [] } }, 'capabilities'],
    [{ capabilities: { bogus: 1 } }, 'capabilities'],
    [{ cost_weight: 0 }, 'cost_weight'],
    [{ cost_weight: '5' }, 'cost_weight'],
    [{ data_policy: 'x'.repeat(2001) }, 'data_policy'],
    [{ enabled: 'true' }, 'enabled'],
  ])('rejects %o on field %s', (patch, field) => {
    let err;
    try { profiles.createProfile(ORG, valid(patch)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(profiles.ProfileValidationError);
    expect(err.field).toBe(field);
  });

  it('accepts dots in slugs so a model id can double as one', () => {
    expect(profiles.createProfile(ORG, valid({ slug: 'gpt-4.1-mini', model_id: 'gpt-4.1-mini' })).slug).toBe('gpt-4.1-mini');
    expect(profiles.getProfile(ORG, 'gpt-4.1-mini')?.slug).toBe('gpt-4.1-mini');
  });

  it('infers capabilities and a cost weight from the provider catalog, stores only overrides', () => {
    const inferred = profiles.createProfile(ORG, valid({ cost_weight: undefined }));
    // Suggested weight = catalog input price ($0.25/M for gpt-5-mini).
    expect(inferred.cost_weight).toBe(0.25);
    const pinned = profiles.updateProfile(ORG, 'gpt-mini', { capabilities: { contextWindow: 200000 } });
    expect(pinned.capabilities).toMatchObject({ contextWindow: 200000, reasoning: true, input: ['text', 'image'] });
    expect(pinned.capability_overrides).toEqual({ contextWindow: 200000 });
    const cleared = profiles.updateProfile(ORG, 'gpt-mini', { capabilities: {} });
    expect(cleared.capabilities.contextWindow).toBe(400000);
    expect(cleared.capability_overrides).toEqual({});
    // Unknown ids fall back to Kuhn defaults and are flagged.
    const unknown = profiles.createProfile(ORG, valid({ slug: 'mystery', model_id: 'acme/mystery-7b', provider: 'openrouter', cost_weight: undefined }));
    expect(unknown).toMatchObject({ catalog_known: false, capabilities: profiles.DEFAULT_CAPABILITIES, cost_weight: 5 });
    expect(profiles.catalogCapabilities('anthropic', 'claude-haiku-4-5')).toMatchObject({ known: true, suggested_cost_weight: 1, capabilities: { reasoning: true } });
    expect(profiles.catalogCapabilities('openai-compatible', 'anything')).toMatchObject({ known: false });
  });

  it('requires a base URL for openai-compatible and allows a keyless local endpoint', () => {
    expect(() => profiles.createProfile(ORG, valid({ provider: 'openai-compatible', credential_secret: null })))
      .toThrow(/base_url is required/);
    const local = profiles.createProfile(ORG, valid({
      provider: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1/', credential_secret: null,
      capabilities: { contextWindow: 32768, reasoning: true },
    }));
    expect(local).toMatchObject({
      base_url: 'http://127.0.0.1:8000/v1', endpoint: 'http://127.0.0.1:8000/v1',
      credential: { kind: 'none' }, capabilities: { contextWindow: 32768, reasoning: true, tools: true },
    });
  });

  it('refuses a duplicate slug', () => {
    profiles.createProfile(ORG, valid());
    expect(() => profiles.createProfile(ORG, valid())).toThrow(/already exists/);
    // Same slug in another org is fine (scoped).
    secrets.setOrgSecret(OTHER_ORG, 'openai-key', 'sk-2');
    expect(profiles.createProfile(OTHER_ORG, valid()).slug).toBe('gpt-mini');
  });

  it('patches fields, keeps the slug immutable, and re-validates provider changes', () => {
    profiles.createProfile(ORG, valid());
    const updated = profiles.updateProfile(ORG, 'gpt-mini', { name: 'Renamed', cost_weight: 3, enabled: false, data_policy: ' no training ' });
    expect(updated).toMatchObject({ name: 'Renamed', cost_weight: 3, enabled: false, data_policy: 'no training' });
    expect(() => profiles.updateProfile(ORG, 'gpt-mini', { slug: 'other' })).toThrow(/slug cannot be changed/);
    // Switching to openai-compatible needs a base URL; the old fixed-endpoint
    // provider forbade one.
    expect(() => profiles.updateProfile(ORG, 'gpt-mini', { provider: 'openai-compatible' })).toThrow(/base_url is required/);
    const moved = profiles.updateProfile(ORG, 'gpt-mini', { provider: 'openai-compatible', base_url: 'https://llm.example.org/v1' });
    expect(moved).toMatchObject({ provider: 'openai-compatible', endpoint: 'https://llm.example.org/v1' });
    expect(profiles.updateProfile(ORG, 'nope', { name: 'x' })).toBeNull();
    expect(profiles.updateProfile(OTHER_ORG, 'gpt-mini', { name: 'x' })).toBeNull();
  });

  it('deletes a profile together with the routes that referenced it', () => {
    profiles.createProfile(ORG, valid());
    profiles.setRoutes(ORG, 'ra', [{ profile_slug: 'gpt-mini', difficulty: 0.5 }]);
    expect(profiles.deleteProfile(OTHER_ORG, 'gpt-mini')).toBe(false);
    expect(profiles.deleteProfile(ORG, 'gpt-mini')).toBe(true);
    expect(profiles.getRoutes(ORG, 'ra')).toEqual([]);
    expect(profiles.deleteProfile(ORG, 'gpt-mini')).toBe(false);
  });
});

describe('routes', () => {
  beforeEach(() => {
    profiles.createProfile(ORG, valid());
    profiles.createProfile(ORG, valid({ slug: 'off', enabled: false }));
  });

  it('stores a ranked list mixing org and deployment profiles, sorted by difficulty', () => {
    const stored = profiles.setRoutes(ORG, 'ra', [
      { profile_slug: 'deployment-claude-opus-4-8', difficulty: 1 },
      { profile_slug: 'gpt-mini', difficulty: 0.4 },
    ], { updatedBy: 1 });
    expect(stored).toEqual([
      { profile_slug: 'gpt-mini', difficulty: 0.4 },
      { profile_slug: 'deployment-claude-opus-4-8', difficulty: 1 },
    ]);
    expect(profiles.listRoutes(ORG)).toEqual({ ra: stored });
    expect(profiles.getRoutes(OTHER_ORG, 'ra')).toEqual([]);
  });

  it('an empty list reverts the role to the deployment default', () => {
    profiles.setRoutes(ORG, 'ra', [{ profile_slug: 'gpt-mini', difficulty: 1 }]);
    expect(profiles.setRoutes(ORG, 'ra', [])).toEqual([]);
    expect(profiles.listRoutes(ORG)).toEqual({});
  });

  it.each([
    [[{ profile_slug: 'nope', difficulty: 1 }], /no profile named 'nope'/],
    [[{ profile_slug: 'off', difficulty: 1 }], /is disabled/],
    [[{ profile_slug: 'gpt-mini', difficulty: 2 }], /between 0 and 1/],
    [[{ profile_slug: 'gpt-mini', difficulty: 1 }, { profile_slug: 'gpt-mini', difficulty: 0 }], /listed twice/],
    ['x', /must be an array/],
    [[null], /must be an object/],
  ])('rejects %j', (routes, message) => {
    expect(() => profiles.setRoutes(ORG, 'ra', routes)).toThrow(message);
    expect(profiles.getRoutes(ORG, 'ra')).toEqual([]);
  });

  it('cannot route through another org\'s profile and returns null for an unknown agent', () => {
    secrets.setOrgSecret(OTHER_ORG, 'openai-key', 'sk-2');
    profiles.createProfile(OTHER_ORG, valid({ slug: 'theirs' }));
    expect(() => profiles.setRoutes(ORG, 'ra', [{ profile_slug: 'theirs', difficulty: 1 }])).toThrow(/no profile named 'theirs'/);
    expect(profiles.setRoutes(ORG, 'ghost', [])).toBeNull();
  });
});
