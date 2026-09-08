// Model profiles and per-role routing (issues #107, #111, #112).
//
// A *profile* is one provider/model/endpoint an agent may run on. Two kinds:
//
//   - Deployment-managed profiles are derived from config at read time (the
//     operator's Anthropic key behind the seeded agents.model ids, and the
//     KUHN_PI_* preview when configured). They are read-only and have no
//     row; their slugs carry the reserved `deployment-` prefix.
//   - Org-owned profiles are rows in model_profiles. They hold a credential
//     REFERENCE — an org_secrets name — never the credential. An org can only
//     ever reference its own secrets and its own profiles (threat model
//     §4.2/§4.3: egress is a property of a tenant-scoped, allowlisted
//     profile, never of anything the model can choose).
//
// A *route* is the per-role ranked list: for an agent slug, the profiles it
// may run on, each with the highest task difficulty (0..1) it is trusted
// with. Selection at dispatch time lives in agents/model-routing.js; this
// module owns storage, validation, and the deployment defaults.
//
// Synchronous (querySync) like the other org-config stores: the agent
// runtime resolves a route on the task hot path without another await.

import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';

import { config } from '../config.js';
import { querySync, transaction } from '../db.js';
import { SECRET_NAME_PATTERN } from './org-secrets.js';

export const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'openai-compatible'];

/** Where each fixed-endpoint provider egresses to (shown to owners). */
export const PROVIDER_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  // Gemini Developer API (issue #133) — an API key, not Vertex/ADC.
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

// Lowercase letters, digits, dots, dashes — so a model id like "gpt-4.1"
// can double as the slug. Slugs travel in URL path segments (encoded).
export const SLUG_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
export const DEPLOYMENT_PREFIX = 'deployment-';
const MAX_NAME_CHARS = 120;
const MAX_MODEL_ID_CHARS = 200;
const MAX_POLICY_CHARS = 2000;
const MIN_CONTEXT_WINDOW = 1024;
const MAX_COST_WEIGHT = 100;

/** Declared capabilities when a profile does not say otherwise. */
export const DEFAULT_CAPABILITIES = Object.freeze({
  reasoning: false,
  input: ['text'],
  contextWindow: 128_000,
  maxTokens: 16_384,
  tools: true,
});

// ---- Provider catalogs ---------------------------------------------------------
// pi-ai ships model metadata for the fixed-endpoint providers. A profile's
// effective capabilities are catalog values (when the id is known) with the
// owner's explicit overrides on top; only the overrides are stored, so a
// catalog update flows through unless the owner pinned a value (e.g. a
// smaller context window to stay under a long-context surcharge).

const CATALOGS = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  openrouter: OPENROUTER_MODELS,
  google: GOOGLE_MODELS,
};

/**
 * What the built-in catalog knows about a model id, or { known: false }.
 * `suggested_cost_weight` is the list input price in $/M tokens — the same
 * scale as the deployment's default AGENT_MODEL_WEIGHTS (Haiku 1, Sonnet 3,
 * Opus 5) — so a fresh profile is metered sensibly without a lookup.
 */
export function catalogCapabilities(provider, modelId) {
  const catalog = CATALOGS[provider];
  const entry = catalog ? Object.values(catalog).find((m) => m.id === modelId) : null;
  if (!entry) return { known: false, capabilities: null, suggested_cost_weight: null, name: null };
  return {
    known: true,
    name: entry.name ?? modelId,
    capabilities: {
      reasoning: entry.reasoning === true,
      input: Array.isArray(entry.input) && entry.input.length ? [...entry.input] : ['text'],
      contextWindow: Number.isInteger(entry.contextWindow) ? entry.contextWindow : DEFAULT_CAPABILITIES.contextWindow,
      maxTokens: Number.isInteger(entry.maxTokens) ? entry.maxTokens : DEFAULT_CAPABILITIES.maxTokens,
      tools: true,
    },
    suggested_cost_weight: typeof entry.cost?.input === 'number' && entry.cost.input > 0
      ? Math.max(0.1, Math.round(entry.cost.input * 100) / 100)
      : null,
  };
}

// Live fallback: OpenRouter publishes a keyless model list with context
// length, output cap, modalities, reasoning/tool support, and pricing, and
// mirrors OpenAI, Anthropic and Google ids under `openai/…` / `anthropic/…` /
// `google/…`. Used only for ids the pinned catalog lacks (a model newer than
// the pi-ai release), cached in memory for an hour. No credential is sent.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LIVE_TTL_MS = 60 * 60 * 1000;
let liveCache = { at: 0, byId: null, pending: null };

async function openRouterModelList() {
  if (liveCache.byId && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.byId;
  if (liveCache.pending) return liveCache.pending;
  liveCache.pending = (async () => {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      const byId = new Map();
      for (const m of Array.isArray(data) ? data : []) if (m?.id) byId.set(m.id, m);
      liveCache = { at: Date.now(), byId, pending: null };
      return byId;
    } catch {
      liveCache.pending = null;
      return null;
    }
  })();
  return liveCache.pending;
}

/** Test hook: forget the cached live list. */
export function resetLiveCatalogCache() {
  liveCache = { at: 0, byId: null, pending: null };
}

function fromOpenRouterEntry(entry) {
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const modalities = Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities : ['text'];
  const promptPrice = Number.parseFloat(entry.pricing?.prompt);
  const perMillion = Number.isFinite(promptPrice) && promptPrice > 0 ? Math.max(0.1, Math.round(promptPrice * 1e6 * 100) / 100) : null;
  return {
    known: true,
    source: 'openrouter-live',
    name: entry.name ?? entry.id,
    capabilities: {
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      input: modalities.filter((m) => m === 'text' || m === 'image').length ? modalities.filter((m) => m === 'text' || m === 'image') : ['text'],
      contextWindow: Number.isInteger(entry.context_length) ? entry.context_length : DEFAULT_CAPABILITIES.contextWindow,
      maxTokens: Number.isInteger(entry.top_provider?.max_completion_tokens) ? entry.top_provider.max_completion_tokens : DEFAULT_CAPABILITIES.maxTokens,
      tools: params.includes('tools'),
    },
    suggested_cost_weight: perMillion,
  };
}

/**
 * The pinned catalog first (source 'catalog'); for a fixed-endpoint provider
 * whose id it lacks, OpenRouter's live list (source 'openrouter-live'); else
 * { known: false }. Async; the sync catalogCapabilities() is what profiles
 * resolve against at read time.
 */
export async function lookupCapabilities(provider, modelId) {
  const pinned = catalogCapabilities(provider, modelId);
  if (pinned.known) return { ...pinned, source: 'catalog' };
  if (!modelId || !CATALOGS[provider]) return { ...pinned, source: null };
  const list = await openRouterModelList();
  if (!list) return { ...pinned, source: null };
  const id = provider === 'openrouter' ? modelId : `${provider}/${modelId}`;
  const entry = list.get(id);
  return entry ? fromOpenRouterEntry(entry) : { ...pinned, source: null };
}

/** Effective capabilities: Kuhn defaults ← catalog ← explicit overrides. */
export function effectiveCapabilities(provider, modelId, overrides) {
  const catalog = catalogCapabilities(provider, modelId).capabilities ?? {};
  return { ...DEFAULT_CAPABILITIES, ...catalog, ...(overrides ?? {}) };
}

/** Field-level validation failure — routes map to 400 { error, field }. */
export class ProfileValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ProfileValidationError';
    this.field = field;
  }
}

// ---- Base-URL policy (threat model §4.2, custom OpenAI-compatible endpoints) ----

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/, /^\[?fc/i, /^\[?fd/i, /^\[?fe80/i,
  /\.(local|internal|localdomain)$/i,
];

/** True for loopback / link-local / RFC-1918 / metadata-style hosts. */
export function isPrivateHost(hostname) {
  const host = (hostname ?? '').replace(/^\[|\]$/g, '');
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Validate an OpenAI-compatible base URL. Absolute, no credentials / query /
 * fragment; https unless the host is private; private hosts only when the
 * operator enabled local endpoints (KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS).
 * @returns {string} the normalized URL (no trailing slash)
 */
export function validateBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProfileValidationError('base_url is required for an OpenAI-compatible endpoint', 'base_url');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProfileValidationError('base_url must be an absolute http(s) URL', 'base_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ProfileValidationError('base_url must use http or https', 'base_url');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProfileValidationError('base_url must not contain credentials, query parameters, or fragments', 'base_url');
  }
  const privateHost = isPrivateHost(url.hostname);
  if (privateHost && !config.agentRuntime?.allowPrivateEndpoints) {
    throw new ProfileValidationError(
      'base_url points at a private or loopback host; the operator must set KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS=true to allow local model servers',
      'base_url',
    );
  }
  if (url.protocol === 'http:' && !privateHost) {
    throw new ProfileValidationError('base_url must use https unless it points at a private host', 'base_url');
  }
  return url.toString().replace(/\/$/, '');
}

// ---- Capabilities --------------------------------------------------------------

/** Validate the owner's explicit overrides (only the keys given are stored). */
function validateCapabilities(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileValidationError('capabilities must be an object', 'capabilities');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'reasoning':
      case 'tools':
        if (typeof value !== 'boolean') throw new ProfileValidationError(`capabilities.${key} must be a boolean`, 'capabilities');
        out[key] = value;
        break;
      case 'input':
        if (!Array.isArray(value) || value.length === 0 || !value.every((v) => v === 'text' || v === 'image')) {
          throw new ProfileValidationError("capabilities.input must be a non-empty array of 'text' | 'image'", 'capabilities');
        }
        out.input = [...new Set(value)];
        break;
      case 'contextWindow':
        if (!Number.isInteger(value) || value < MIN_CONTEXT_WINDOW) {
          throw new ProfileValidationError(`capabilities.contextWindow must be an integer >= ${MIN_CONTEXT_WINDOW}`, 'capabilities');
        }
        out.contextWindow = value;
        break;
      case 'maxTokens':
        if (!Number.isInteger(value) || value < 1) {
          throw new ProfileValidationError('capabilities.maxTokens must be a positive integer', 'capabilities');
        }
        out.maxTokens = value;
        break;
      default:
        throw new ProfileValidationError(`unknown capability: ${key}`, 'capabilities');
    }
  }
  return out;
}

function parseOverrides(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---- Deployment-managed profiles -----------------------------------------------

/** Deployment profile slug for a model id ('claude-opus-4-8' → 'deployment-claude-opus-4-8'). */
export function deploymentSlug(modelId) {
  const stem = (modelId ?? 'default').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${DEPLOYMENT_PREFIX}${stem || 'default'}`;
}

/** The cost weight the deployment's AGENT_MODEL_WEIGHTS assign to a model id. */
export function deploymentCostWeight(modelId) {
  const weights = config.agent?.modelWeights ?? { default: 5 };
  const id = (modelId ?? '').toLowerCase();
  for (const [key, weight] of Object.entries(weights)) {
    if (key !== 'default' && id.includes(key)) return weight;
  }
  return weights.default ?? 5;
}

const PI_DEFAULT_API_KEY_ENV = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

/** Slug of the deployment Pi preview profile (KUHN_AGENT_RUNTIME=pi). */
export const PI_PREVIEW_SLUG = `${DEPLOYMENT_PREFIX}pi-preview`;

function anthropicDeploymentProfile(modelId) {
  return {
    id: null,
    slug: deploymentSlug(modelId),
    name: modelId ? `Anthropic ${modelId} (deployment)` : 'Anthropic default (deployment)',
    provider: 'anthropic',
    model_id: modelId ?? null,
    base_url: null,
    endpoint: PROVIDER_ENDPOINTS.anthropic,
    credential: { kind: 'deployment', secret: null },
    capabilities: effectiveCapabilities('anthropic', modelId, catalogCapabilities('anthropic', modelId).known ? {} : { contextWindow: config.agent?.contextWindow ?? 200_000, reasoning: true }),
    capability_overrides: {},
    catalog_known: catalogCapabilities('anthropic', modelId).known,
    cost_weight: deploymentCostWeight(modelId),
    data_policy: null,
    enabled: true,
    managed: true,
  };
}

/** The KUHN_PI_* preview as a deployment profile, or null when unconfigured. */
export function piPreviewProfile() {
  const pi = config.agentRuntime?.pi ?? {};
  if (!pi.model) return null;
  const provider = (pi.provider || 'openrouter').toLowerCase();
  if (!PI_DEFAULT_API_KEY_ENV[provider]) return null;
  return {
    id: null,
    slug: PI_PREVIEW_SLUG,
    name: `Pi preview: ${provider} ${pi.model}`,
    provider,
    model_id: pi.model,
    base_url: provider === 'openai-compatible' ? (pi.baseUrl || null) : null,
    endpoint: provider === 'openai-compatible' ? (pi.baseUrl || null) : PROVIDER_ENDPOINTS[provider],
    credential: { kind: 'deployment', secret: null, env: pi.apiKeyEnv || PI_DEFAULT_API_KEY_ENV[provider] },
    capabilities: effectiveCapabilities(provider, pi.model, {}),
    capability_overrides: {},
    catalog_known: catalogCapabilities(provider, pi.model).known,
    cost_weight: config.agent?.modelWeights?.default ?? 5,
    data_policy: null,
    enabled: true,
    managed: true,
  };
}

/** Seeded agent models, in agent order (querySync; agents table). */
function seededAgentModels() {
  const { rows } = querySync('SELECT slug, model FROM agents ORDER BY id');
  return rows;
}

/**
 * Every deployment-managed profile: one Anthropic profile per distinct seeded
 * agent model (plus the AGENT_MODEL fallback when set), and the Pi preview
 * when configured. Order is stable (agents order, then the preview).
 */
export function deploymentProfiles() {
  const out = new Map();
  const models = seededAgentModels().map((r) => r.model);
  if (config.agent?.model) models.push(config.agent.model);
  for (const modelId of models) {
    const profile = anthropicDeploymentProfile(modelId ?? null);
    if (!out.has(profile.slug)) out.set(profile.slug, profile);
  }
  const pi = piPreviewProfile();
  if (pi) out.set(pi.slug, pi);
  return [...out.values()];
}

/**
 * The profile a role runs on when the org has configured no route for it —
 * exactly today's behavior: the seeded agents.model on the deployment's
 * Anthropic key, or the Pi preview when KUHN_AGENT_RUNTIME=pi.
 * @param {{ slug: string, model?: string|null }} agent
 */
export function deploymentDefaultProfile(agent) {
  if ((config.agentRuntime?.kind ?? 'claude') === 'pi') {
    const pi = piPreviewProfile();
    // Budget weighting keeps the role's seeded tier (a Haiku RA still burns
    // the budget at the Haiku rate) — the pre-#107 behavior of the preview,
    // and what keeps the two conformance drivers' accounting identical.
    if (pi) return { ...pi, cost_weight: deploymentCostWeight(agent?.model ?? config.agent?.model ?? null) };
    // No usable preview config: keep the factory's loud failure by handing
    // it a Pi profile it cannot build (empty model id) rather than quietly
    // running Claude.
    return {
      ...anthropicDeploymentProfile(null),
      slug: PI_PREVIEW_SLUG,
      provider: (config.agentRuntime?.pi?.provider || 'openrouter').toLowerCase(),
      model_id: '',
      endpoint: null,
      credential: { kind: 'deployment', secret: null, env: null },
    };
  }
  return anthropicDeploymentProfile(agent?.model ?? config.agent?.model ?? null);
}

// ---- Org-owned profiles --------------------------------------------------------

const publicRow = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  provider: row.provider,
  model_id: row.model_id,
  base_url: row.base_url,
  endpoint: row.provider === 'openai-compatible' ? row.base_url : PROVIDER_ENDPOINTS[row.provider],
  credential: row.credential_secret
    ? { kind: 'secret', secret: row.credential_secret }
    : { kind: 'none', secret: null },
  capabilities: effectiveCapabilities(row.provider, row.model_id, parseOverrides(row.capabilities)),
  capability_overrides: parseOverrides(row.capabilities),
  catalog_known: catalogCapabilities(row.provider, row.model_id).known,
  cost_weight: row.cost_weight,
  data_policy: row.data_policy,
  enabled: row.enabled === 1,
  managed: false,
  created_by: row.created_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Org-owned profiles only, by slug. */
export function listOrgProfiles(orgId) {
  const { rows } = querySync('SELECT * FROM model_profiles WHERE org_id = $1 ORDER BY slug', [orgId]);
  return rows.map(publicRow);
}

/** Deployment-managed profiles followed by the org's own. */
export function listProfiles(orgId) {
  return [...deploymentProfiles(), ...listOrgProfiles(orgId)];
}

/** One profile by slug — the org's own or a deployment one; null if absent. */
export function getProfile(orgId, slug) {
  if (typeof slug !== 'string') return null;
  if (slug.startsWith(DEPLOYMENT_PREFIX)) {
    return deploymentProfiles().find((p) => p.slug === slug) ?? null;
  }
  const { rows } = querySync('SELECT * FROM model_profiles WHERE org_id = $1 AND slug = $2', [orgId, slug]);
  return rows[0] ? publicRow(rows[0]) : null;
}

function secretExists(orgId, name) {
  const { rows } = querySync('SELECT 1 FROM org_secrets WHERE org_id = $1 AND name = $2', [orgId, name]);
  return rows.length > 0;
}

/**
 * Validate an org profile payload. `partial` skips absent keys (PATCH).
 * @returns {object} normalized column values
 */
function validateProfileInput(orgId, input, { partial = false, current = null } = {}) {
  if (!input || typeof input !== 'object') throw new ProfileValidationError('body must be an object', 'body');
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('slug')) {
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    if (!SLUG_PATTERN.test(slug)) {
      throw new ProfileValidationError('slug must be 1-64 chars: lowercase letters, digits, dashes; starting with a letter', 'slug');
    }
    if (slug.startsWith(DEPLOYMENT_PREFIX)) {
      throw new ProfileValidationError(`slugs starting with '${DEPLOYMENT_PREFIX}' are reserved for deployment-managed profiles`, 'slug');
    }
    out.slug = slug;
  }
  if (!partial || has('name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MAX_NAME_CHARS) {
      throw new ProfileValidationError(`name must be 1-${MAX_NAME_CHARS} characters`, 'name');
    }
    out.name = name;
  }
  const provider = has('provider') ? input.provider : current?.provider;
  if (!partial || has('provider')) {
    if (!PROVIDERS.includes(provider)) {
      throw new ProfileValidationError(`provider must be one of: ${PROVIDERS.join(', ')}`, 'provider');
    }
    out.provider = provider;
  }
  if (!partial || has('model_id')) {
    const modelId = typeof input.model_id === 'string' ? input.model_id.trim() : '';
    if (!modelId || modelId.length > MAX_MODEL_ID_CHARS || /[\s -]/.test(modelId)) {
      throw new ProfileValidationError(`model_id must be 1-${MAX_MODEL_ID_CHARS} characters with no whitespace`, 'model_id');
    }
    out.model_id = modelId;
  }
  // base_url: required for openai-compatible, forbidden otherwise. Re-check
  // whenever the provider or the URL changes.
  if (!partial || has('base_url') || has('provider')) {
    const raw = has('base_url') ? input.base_url : current?.base_url;
    if (provider === 'openai-compatible') {
      out.base_url = validateBaseUrl(raw);
    } else {
      if (raw != null && raw !== '') {
        throw new ProfileValidationError(`base_url is only allowed for an openai-compatible profile (${provider} has a fixed endpoint)`, 'base_url');
      }
      out.base_url = null;
    }
  }
  if (!partial || has('credential_secret') || has('provider')) {
    const raw = has('credential_secret') ? input.credential_secret : current?.credential?.secret ?? null;
    if (raw == null || raw === '') {
      if (provider !== 'openai-compatible') {
        throw new ProfileValidationError('credential_secret (an org secret name) is required for this provider', 'credential_secret');
      }
      out.credential_secret = null;
    } else {
      if (typeof raw !== 'string' || !SECRET_NAME_PATTERN.test(raw)) {
        throw new ProfileValidationError('credential_secret must be an org secret name', 'credential_secret');
      }
      // An org can only reference its OWN secrets (the row is scoped by
      // org_id, so a stranger's secret name simply does not exist here).
      if (!secretExists(orgId, raw)) {
        throw new ProfileValidationError(`no org secret named '${raw}' — save the credential first`, 'credential_secret');
      }
      out.credential_secret = raw;
    }
  }
  if (!partial || has('capabilities')) {
    out.capabilities = JSON.stringify(validateCapabilities(input.capabilities));
  }
  if (!partial || has('cost_weight')) {
    const suggested = catalogCapabilities(provider, out.model_id ?? current?.model_id).suggested_cost_weight;
    // null/undefined = "use the suggestion" (the UI's default choice).
    const w = input.cost_weight ?? suggested ?? config.agent?.modelWeights?.default ?? 5;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > MAX_COST_WEIGHT) {
      throw new ProfileValidationError(`cost_weight must be a number in (0, ${MAX_COST_WEIGHT}]`, 'cost_weight');
    }
    out.cost_weight = w;
  }
  if (!partial || has('data_policy')) {
    const policy = input.data_policy;
    if (policy != null && (typeof policy !== 'string' || policy.length > MAX_POLICY_CHARS)) {
      throw new ProfileValidationError(`data_policy must be a string of at most ${MAX_POLICY_CHARS} characters`, 'data_policy');
    }
    out.data_policy = policy ? policy.trim() || null : null;
  }
  if (!partial || has('enabled')) {
    const enabled = has('enabled') ? input.enabled : true;
    if (typeof enabled !== 'boolean') throw new ProfileValidationError('enabled must be a boolean', 'enabled');
    out.enabled = enabled ? 1 : 0;
  }
  return out;
}

/** Create an org profile. A slug clash surfaces as a ProfileValidationError on slug. */
export function createProfile(orgId, input, { createdBy = null } = {}) {
  const v = validateProfileInput(orgId, input);
  if (getProfile(orgId, v.slug)) {
    throw new ProfileValidationError(`a profile named '${v.slug}' already exists`, 'slug');
  }
  const { rows } = querySync(
    `INSERT INTO model_profiles (org_id, slug, name, provider, model_id, base_url, credential_secret,
                                 capabilities, cost_weight, data_policy, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [orgId, v.slug, v.name, v.provider, v.model_id, v.base_url, v.credential_secret,
      v.capabilities, v.cost_weight, v.data_policy, v.enabled, createdBy],
  );
  return publicRow(rows[0]);
}

/**
 * Patch an org profile (slug is immutable — routes reference it). Deployment
 * profiles are read-only: null for those and for unknown slugs.
 */
export function updateProfile(orgId, slug, patch) {
  if (typeof slug !== 'string' || slug.startsWith(DEPLOYMENT_PREFIX)) return null;
  const current = getProfile(orgId, slug);
  if (!current) return null;
  const input = { ...(patch ?? {}) };
  if (Object.prototype.hasOwnProperty.call(input, 'slug')) {
    if (input.slug !== slug) throw new ProfileValidationError('slug cannot be changed', 'slug');
    delete input.slug;
  }
  const v = validateProfileInput(orgId, input, { partial: true, current });
  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries(v)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return current;
  params.push(orgId, slug);
  const { rows } = querySync(
    `UPDATE model_profiles SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE org_id = $${params.length - 1} AND slug = $${params.length}
     RETURNING *`,
    params,
  );
  return publicRow(rows[0]);
}

/**
 * Delete an org profile and any routes that referenced it.
 * @returns {boolean} true if a row was deleted
 */
export function deleteProfile(orgId, slug) {
  if (typeof slug !== 'string' || slug.startsWith(DEPLOYMENT_PREFIX)) return false;
  return transaction(() => {
    const { rows } = querySync(
      'DELETE FROM model_profiles WHERE org_id = $1 AND slug = $2 RETURNING id',
      [orgId, slug],
    );
    if (rows.length === 0) return false;
    querySync('DELETE FROM agent_model_routes WHERE org_id = $1 AND profile_slug = $2', [orgId, slug]);
    return true;
  });
}

// ---- Per-role routes -----------------------------------------------------------

/** All routes for an org: { [agentSlug]: [{ profile_slug, difficulty }] } sorted by difficulty. */
export function listRoutes(orgId) {
  const { rows } = querySync(
    'SELECT agent_slug, profile_slug, difficulty FROM agent_model_routes WHERE org_id = $1 ORDER BY agent_slug, difficulty, profile_slug',
    [orgId],
  );
  const out = {};
  for (const row of rows) {
    (out[row.agent_slug] ??= []).push({ profile_slug: row.profile_slug, difficulty: row.difficulty });
  }
  return out;
}

/** The ranked route list for one role (sorted by difficulty), [] when unset. */
export function getRoutes(orgId, agentSlug) {
  const { rows } = querySync(
    'SELECT profile_slug, difficulty FROM agent_model_routes WHERE org_id = $1 AND agent_slug = $2 ORDER BY difficulty, profile_slug',
    [orgId, agentSlug],
  );
  return rows;
}

function agentExists(slug) {
  const { rows } = querySync('SELECT 1 FROM agents WHERE slug = $1', [slug]);
  return rows.length > 0;
}

/**
 * Replace a role's ranked route list. An empty list reverts the role to the
 * deployment default. Every profile must be this org's (or a deployment
 * one) and enabled; difficulties in [0, 1]; no profile listed twice.
 * @param {Array<{ profile_slug: string, difficulty: number }>} routes
 * @returns {Array<{ profile_slug, difficulty }>|null} the stored list, or null for an unknown agent
 */
export function setRoutes(orgId, agentSlug, routes, { updatedBy = null } = {}) {
  if (typeof agentSlug !== 'string' || !agentExists(agentSlug)) return null;
  if (!Array.isArray(routes)) throw new ProfileValidationError('routes must be an array', 'routes');
  const seen = new Set();
  const normalized = routes.map((route, i) => {
    const field = `routes[${i}]`;
    if (!route || typeof route !== 'object') throw new ProfileValidationError(`${field} must be an object`, field);
    const { profile_slug: slug, difficulty } = route;
    if (typeof slug !== 'string' || !slug) throw new ProfileValidationError(`${field}.profile_slug is required`, field);
    if (seen.has(slug)) throw new ProfileValidationError(`${field}: profile '${slug}' is listed twice`, field);
    seen.add(slug);
    if (typeof difficulty !== 'number' || !Number.isFinite(difficulty) || difficulty < 0 || difficulty > 1) {
      throw new ProfileValidationError(`${field}.difficulty must be a number between 0 and 1`, field);
    }
    const profile = getProfile(orgId, slug);
    if (!profile) throw new ProfileValidationError(`${field}: no profile named '${slug}' in this organization`, field);
    if (!profile.enabled) throw new ProfileValidationError(`${field}: profile '${slug}' is disabled`, field);
    return { profile_slug: slug, difficulty };
  });
  return transaction(() => {
    querySync('DELETE FROM agent_model_routes WHERE org_id = $1 AND agent_slug = $2', [orgId, agentSlug]);
    for (const r of normalized) {
      querySync(
        `INSERT INTO agent_model_routes (org_id, agent_slug, profile_slug, difficulty, updated_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, agentSlug, r.profile_slug, r.difficulty, updatedBy],
      );
    }
    return getRoutes(orgId, agentSlug);
  });
}
