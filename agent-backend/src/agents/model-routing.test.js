// Dispatch-time model routing (issue #107): the selection rule, the
// capability gate, resolution against the real route store, and server-side
// credential resolution that never leaks the value.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config; let querySync; let routing; let profiles; let secrets;
const ORG = 1;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  const { exec, querySync: qs } = await import('../db.js');
  querySync = qs;
  exec(readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8'));
  routing = await import('./model-routing.js');
  profiles = await import('../db/model-profiles.js');
  secrets = await import('../db/org-secrets.js');
});

beforeEach(() => {
  for (const t of ['agent_model_routes', 'model_profiles', 'org_secrets', 'agents', 'organizations']) querySync(`DELETE FROM ${t}`);
  querySync(`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Lab', 'lab')`);
  querySync(`INSERT INTO agents (slug, name, system_prompt, model) VALUES ('ra', 'RA', 'x', 'claude-haiku-4-5'), ('pm', 'PM', 'x', 'claude-opus-4-8')`);
  config.agentRuntime = { kind: 'claude', pi: { provider: '', model: '', baseUrl: '', apiKeyEnv: '' }, allowPrivateEndpoints: true };
  config.agent = { ...config.agent, model: undefined, modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 } };
  secrets.setOrgSecret(ORG, 'or-key', 'sk-or-secret');
  profiles.createProfile(ORG, { slug: 'cheap', name: 'Cheap', provider: 'openrouter', model_id: 'openai/gpt-oss-20b', credential_secret: 'or-key', cost_weight: 0.5 });
  profiles.createProfile(ORG, { slug: 'mid', name: 'Mid', provider: 'openrouter', model_id: 'qwen/qwen3-235b', credential_secret: 'or-key', cost_weight: 1 });
  profiles.createProfile(ORG, { slug: 'local', name: 'Local', provider: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1', model_id: 'qwen-science' });
});

const RA = { slug: 'ra', model: 'claude-haiku-4-5' };

describe('normalizeDifficulty', () => {
  it('clamps to [0, 1] and defaults unusable values to the hardest', () => {
    expect(routing.normalizeDifficulty(0.3)).toBe(0.3);
    expect(routing.normalizeDifficulty('0.25')).toBe(0.25);
    expect(routing.normalizeDifficulty(-1)).toBe(0);
    expect(routing.normalizeDifficulty(7)).toBe(1);
    for (const v of [undefined, null, NaN, 'x', {}]) expect(routing.normalizeDifficulty(v)).toBe(1);
  });
});

describe('selectRoute', () => {
  const routes = [
    { profile_slug: 'cheap', difficulty: 0.3 },
    { profile_slug: 'mid', difficulty: 0.7 },
    { profile_slug: 'top', difficulty: 1 },
  ];
  it('picks the cheapest entry whose ceiling covers the task', () => {
    expect(routing.selectRoute(routes, 0).profile_slug).toBe('cheap');
    expect(routing.selectRoute(routes, 0.3).profile_slug).toBe('cheap');
    expect(routing.selectRoute(routes, 0.31).profile_slug).toBe('mid');
    expect(routing.selectRoute(routes, 1).profile_slug).toBe('top');
  });
  it('falls back to the strongest entry when nothing covers the difficulty', () => {
    expect(routing.selectRoute(routes.slice(0, 2), 0.9).profile_slug).toBe('mid');
    expect(routing.selectRoute([], 0.5)).toBeNull();
    expect(routing.selectRoute(undefined, 0.5)).toBeNull();
  });
});

describe('requirementFailure', () => {
  it('accepts a normal profile and rejects unusable ones with a reason', () => {
    expect(routing.requirementFailure(profiles.getProfile(ORG, 'cheap'))).toBeNull();
    expect(routing.requirementFailure(null)).toMatch(/no model profile/);
    expect(routing.requirementFailure({ slug: 'x', enabled: false })).toMatch(/disabled/);
    expect(routing.requirementFailure({ slug: 'x', enabled: true, capabilities: { tools: false } })).toMatch(/no tool support/);
    expect(routing.requirementFailure({ slug: 'x', enabled: true, capabilities: { input: ['image'] } })).toMatch(/no text input/);
    expect(routing.requirementFailure({ slug: 'x', enabled: true, capabilities: {}, credential: { kind: 'secret', secret: null } })).toMatch(/names no credential/);
  });
});

describe('resolveRoute', () => {
  it('returns the deployment default when the org has no route (and for a null org)', () => {
    expect(routing.resolveRoute({ orgId: ORG, agent: RA, difficulty: 0.2 })).toMatchObject({
      source: 'deployment', difficulty: 0.2, routes: [],
      profile: { slug: 'deployment-claude-haiku-4-5', provider: 'anthropic', cost_weight: 1 },
    });
    expect(routing.resolveRoute({ orgId: null, agent: RA }).profile.slug).toBe('deployment-claude-haiku-4-5');
  });

  it('follows the org route list by difficulty', () => {
    profiles.setRoutes(ORG, 'ra', [
      { profile_slug: 'cheap', difficulty: 0.3 },
      { profile_slug: 'mid', difficulty: 0.7 },
      { profile_slug: 'deployment-claude-opus-4-8', difficulty: 1 },
    ]);
    expect(routing.resolveRoute({ orgId: ORG, agent: RA, difficulty: 0.1 }).profile.slug).toBe('cheap');
    expect(routing.resolveRoute({ orgId: ORG, agent: RA, difficulty: 0.5 }).profile.slug).toBe('mid');
    const top = routing.resolveRoute({ orgId: ORG, agent: RA });
    expect(top).toMatchObject({ source: 'org', difficulty: 1, profile: { slug: 'deployment-claude-opus-4-8', provider: 'anthropic' } });
    // Another role is untouched.
    expect(routing.resolveRoute({ orgId: ORG, agent: { slug: 'pm', model: 'claude-opus-4-8' } }).source).toBe('deployment');
  });

  it('surfaces a route whose deployment profile vanished as an unusable profile, not a silent fallback', () => {
    config.agentRuntime.pi = { provider: 'openrouter', model: 'openai/gpt-oss-20b', baseUrl: '', apiKeyEnv: '' };
    profiles.setRoutes(ORG, 'ra', [{ profile_slug: profiles.PI_PREVIEW_SLUG, difficulty: 1 }]);
    config.agentRuntime.pi.model = '';
    const route = routing.resolveRoute({ orgId: ORG, agent: RA });
    expect(route.profile).toMatchObject({ slug: profiles.PI_PREVIEW_SLUG, missing: true, enabled: false });
    expect(routing.requirementFailure(route.profile)).toMatch(/disabled/);
  });
});

describe('resolveCredential', () => {
  it('resolves an org secret to a value the caller hands to the adapter only', () => {
    expect(routing.resolveCredential(ORG, profiles.getProfile(ORG, 'cheap'))).toEqual({ apiKey: 'sk-or-secret' });
    // The profile object itself never carries the value.
    expect(JSON.stringify(profiles.getProfile(ORG, 'cheap'))).not.toContain('sk-or-secret');
  });
  it('maps deployment profiles to their env var name and keyless endpoints to nothing', () => {
    expect(routing.resolveCredential(ORG, profiles.getProfile(ORG, 'local'))).toEqual({});
    expect(routing.resolveCredential(ORG, profiles.deploymentDefaultProfile(RA))).toEqual({});
    config.agentRuntime.pi = { provider: 'openai', model: 'gpt-5-mini', baseUrl: '', apiKeyEnv: 'MY_OPENAI' };
    expect(routing.resolveCredential(ORG, profiles.piPreviewProfile())).toEqual({ apiKeyEnv: 'MY_OPENAI' });
  });
  it('fails loudly when the referenced secret is gone', () => {
    const profile = profiles.getProfile(ORG, 'cheap');
    secrets.deleteOrgSecret(ORG, 'or-key');
    expect(() => routing.resolveCredential(ORG, profile)).toThrow(/credential secret 'or-key' is missing/);
    expect(() => routing.resolveCredential(null, profile)).toThrow(/missing/);
  });
});
