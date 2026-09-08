// Platform-level pre-configured model profiles (issue #138).
//
// A deployment that has local or contracted LLMs available — a vLLM box on
// the LAN, a site-licensed API key — should not make every org owner type the
// same endpoint into Settings → Models. KUHN_PLATFORM_MODELS declares those
// models once, in the environment: either inline JSON or the path of a JSON
// file, an array of entries:
//
//   {
//     "slug": "local-qwen",                     // required; becomes profile slug deployment-local-qwen
//     "name": "Qwen3 27B (on-prem vLLM)",       // optional display name
//     "provider": "openai-compatible",          // anthropic | openai | openrouter | google | openai-compatible
//     "model_id": "Qwen3-27B",                  // required
//     "base_url": "http://vllm.lan:8000/v1",    // openai-compatible only; private hosts allowed (operator-declared)
//     "api_key_env": "LOCAL_LLM_API_KEY",       // optional env var holding the key; absent = the provider's
//                                               //   default variable, or keyless for openai-compatible
//     "capabilities": { "contextWindow": 32768, "maxTokens": 8192, "reasoning": false, "tools": true },
//     "cost_weight": 0.5,                       // optional; AGENT_MODEL_WEIGHTS units (catalog price when known)
//     "data_policy": "Runs on-prem; nothing leaves the network.",
//     "routes": { "ra": 0.5, "writer": 0.3 }    // optional: default route ceilings per agent slug ("*" = every
//                                               //   agent) for orgs that have configured no route of their own
//   }
//
// The entries become deployment-managed profiles (read-only in every org's
// Models tab, routable by owners, testable with "Test connection"); entries
// with `routes` also act as the platform default route for those agents, in
// place of the seeded per-agent Anthropic model. Credentials stay in the
// environment — this file never holds a key.
//
// Validation is strict and happens at boot (index.js): a malformed list
// fails startup with the offending entry and field, never a silent skip.

import { readFileSync } from 'node:fs';

import { config } from '../config.js';

const SLUG_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_NAME_CHARS = 120;
const MAX_MODEL_ID_CHARS = 200;
const MAX_POLICY_CHARS = 2000;

export class PlatformModelsError extends Error {
  constructor(message) {
    super(`KUHN_PLATFORM_MODELS: ${message}`);
    this.name = 'PlatformModelsError';
  }
}

function fail(index, field, message) {
  throw new PlatformModelsError(`entry ${index}${field ? ` (${field})` : ''}: ${message}`);
}

function parseCapabilities(index, input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail(index, 'capabilities', 'must be an object');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'reasoning':
      case 'tools':
        if (typeof value !== 'boolean') fail(index, `capabilities.${key}`, 'must be a boolean');
        out[key] = value;
        break;
      case 'input':
        if (!Array.isArray(value) || value.length === 0 || !value.every((v) => v === 'text' || v === 'image')) {
          fail(index, 'capabilities.input', "must be a non-empty array of 'text' | 'image'");
        }
        out.input = [...new Set(value)];
        break;
      case 'contextWindow':
        if (!Number.isInteger(value) || value < 1024) fail(index, 'capabilities.contextWindow', 'must be an integer >= 1024');
        out.contextWindow = value;
        break;
      case 'maxTokens':
        if (!Number.isInteger(value) || value < 1) fail(index, 'capabilities.maxTokens', 'must be a positive integer');
        out.maxTokens = value;
        break;
      default:
        fail(index, `capabilities.${key}`, 'unknown capability');
    }
  }
  return out;
}

function parseBaseUrl(index, value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    fail(index, 'base_url', 'must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(index, 'base_url', 'must use http or https');
  if (url.username || url.password || url.search || url.hash) {
    fail(index, 'base_url', 'must not contain credentials, query parameters, or fragments');
  }
  return url.toString().replace(/\/$/, '');
}

function parseRoutes(index, input, agentPattern = /^(\*|[a-z][a-z0-9_-]{0,63})$/) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail(index, 'routes', 'must be an object of agent slug → difficulty ceiling');
  const out = {};
  for (const [agent, difficulty] of Object.entries(input)) {
    if (!agentPattern.test(agent)) fail(index, `routes.${agent}`, 'agent slug must be lowercase letters/digits/dashes, or "*"');
    if (typeof difficulty !== 'number' || !Number.isFinite(difficulty) || difficulty < 0 || difficulty > 1) {
      fail(index, `routes.${agent}`, 'difficulty ceiling must be a number between 0 and 1');
    }
    out[agent] = difficulty;
  }
  return out;
}

/**
 * Parse and validate the platform model list.
 * @param {string} raw - inline JSON (starts with `[` or `{`) or a file path; '' → []
 * @param {{ providers: string[], readFile?: (path: string) => string }} options
 * @returns {Array<object>} normalized entries
 * @throws {PlatformModelsError}
 */
export function parsePlatformModels(raw, { providers, readFile = (p) => readFileSync(p, 'utf-8') }) {
  const text = (raw ?? '').trim();
  if (!text) return [];
  let source = text;
  // Inline JSON starts with a bracket or brace; anything else is a file path.
  if (!/^[[{]/.test(text)) {
    try {
      source = readFile(text);
    } catch (err) {
      throw new PlatformModelsError(`cannot read ${text}: ${err.message}`);
    }
  }
  let list;
  try {
    list = JSON.parse(source);
  } catch (err) {
    throw new PlatformModelsError(`not valid JSON (${err.message})`);
  }
  if (!Array.isArray(list)) throw new PlatformModelsError('must be a JSON array of model entries');

  const seen = new Set();
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(index, null, 'must be an object');
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!SLUG_PATTERN.test(slug)) fail(index, 'slug', 'must be 1-64 chars: lowercase letters, digits, dots, dashes; starting with a letter');
    if (slug === 'pi-preview') fail(index, 'slug', "'pi-preview' is reserved for the KUHN_PI_* preview profile");
    if (seen.has(slug)) fail(index, 'slug', `'${slug}' is listed twice`);
    seen.add(slug);
    const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
    if (!providers.includes(provider)) fail(index, 'provider', `must be one of: ${providers.join(', ')}`);
    const modelId = typeof entry.model_id === 'string' ? entry.model_id.trim() : '';
    if (!modelId || modelId.length > MAX_MODEL_ID_CHARS || /[\s]/.test(modelId)) {
      fail(index, 'model_id', `must be 1-${MAX_MODEL_ID_CHARS} characters with no whitespace`);
    }
    const name = entry.name == null ? `${modelId} (platform)` : String(entry.name).trim();
    if (!name || name.length > MAX_NAME_CHARS) fail(index, 'name', `must be 1-${MAX_NAME_CHARS} characters`);
    let baseUrl = null;
    if (provider === 'openai-compatible') {
      if (entry.base_url == null || entry.base_url === '') fail(index, 'base_url', 'is required for an openai-compatible model');
      baseUrl = parseBaseUrl(index, entry.base_url);
    } else if (entry.base_url != null && entry.base_url !== '') {
      fail(index, 'base_url', `is only allowed for openai-compatible (${provider} has a fixed endpoint)`);
    }
    let apiKeyEnv = null;
    if (entry.api_key_env != null && entry.api_key_env !== '') {
      if (typeof entry.api_key_env !== 'string' || !ENV_NAME_PATTERN.test(entry.api_key_env)) {
        fail(index, 'api_key_env', 'must be an environment variable NAME (e.g. LOCAL_LLM_API_KEY), never a value');
      }
      apiKeyEnv = entry.api_key_env;
    }
    let costWeight = null;
    if (entry.cost_weight != null) {
      if (typeof entry.cost_weight !== 'number' || !Number.isFinite(entry.cost_weight) || entry.cost_weight <= 0 || entry.cost_weight > 100) {
        fail(index, 'cost_weight', 'must be a number in (0, 100]');
      }
      costWeight = entry.cost_weight;
    }
    let dataPolicy = null;
    if (entry.data_policy != null) {
      if (typeof entry.data_policy !== 'string' || entry.data_policy.length > MAX_POLICY_CHARS) {
        fail(index, 'data_policy', `must be a string of at most ${MAX_POLICY_CHARS} characters`);
      }
      dataPolicy = entry.data_policy.trim() || null;
    }
    return {
      slug, name, provider, model_id: modelId, base_url: baseUrl, api_key_env: apiKeyEnv,
      capabilities: parseCapabilities(index, entry.capabilities),
      cost_weight: costWeight, data_policy: dataPolicy,
      routes: parseRoutes(index, entry.routes),
    };
  });
}

// Memoized on the raw configuration string: the environment does not change
// under a running process, and the loader sits on the dispatch hot path.
let cache = { raw: null, entries: [] };

/**
 * The validated platform model list for this process (KUHN_PLATFORM_MODELS).
 * @param {{ providers: string[] }} options
 * @throws {PlatformModelsError} on a malformed list
 */
export function loadPlatformModels({ providers }) {
  const raw = config.agentRuntime?.platformModels ?? '';
  if (cache.raw === raw) return cache.entries;
  const entries = parsePlatformModels(raw, { providers });
  cache = { raw, entries };
  return entries;
}

/** Test hook: forget the memoized list. */
export function resetPlatformModelsCache() {
  cache = { raw: null, entries: [] };
}
