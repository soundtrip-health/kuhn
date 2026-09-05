/**
 * AgentRuntime factory (STH-47 preview): the one place the provider choice
 * is made. The product code (agents/runtime.js) calls createAgentRuntime()
 * and consumes the normalized contract — it never constructs or names a
 * provider adapter directly.
 *
 * - 'claude' (default): the Claude AgentRuntime adapter (production path,
 *   unchanged behavior).
 * - 'pi': the Pi AgentRuntime adapter built from the explicit pi preview
 *   configuration (provider path, model id, OpenAI-compatible base URL,
 *   explicitly named credential environment variable). Kuhn's per-agent
 *   Claude model ids (agents.model) are deliberately NOT reinterpreted as
 *   Pi model ids — the preview model is always the explicit one.
 *
 * No silent fallback: a misconfigured 'pi' selection throws at task start
 * and the task fails with that error — it never quietly runs Claude.
 * Rolling back is an explicit operator change of KUHN_AGENT_RUNTIME.
 */

import { config } from '../../config.js';
import { createClaudeRuntime } from './claude-runtime.js';
import {
  createGooglePiRuntime,
  createOpenAICompatiblePiRuntime,
  createOpenAIPiRuntime,
  createOpenRouterPiRuntime,
} from './pi-adapter.js';

export const AGENT_RUNTIME_KINDS = ['claude', 'pi'];

/** Default credential environment variable per Pi provider path. */
const PI_DEFAULT_API_KEY_ENV = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

/** The selected runtime kind ('claude' | 'pi'). Throws on an unknown kind —
 * a misspelled selector must fail loudly, not default to another runtime. */
export function agentRuntimeKind() {
  const kind = (config.agentRuntime?.kind ?? 'claude').toLowerCase();
  if (!AGENT_RUNTIME_KINDS.includes(kind)) {
    throw new Error(
      `Unknown agent runtime kind '${kind}' (expected: ${AGENT_RUNTIME_KINDS.join(' | ')}); no fallback to another runtime is applied`,
    );
  }
  return kind;
}

/**
 * Build the AgentRuntime adapter for a task.
 *
 * Two ways in:
 *
 * - `profile` (issue #107/#111): a resolved model profile (db/model-
 *   profiles.js) plus the credential the routing layer resolved for it
 *   (`credential`: { apiKey } for an org secret, { apiKeyEnv } for a
 *   deployment env var, {} for a keyless local endpoint). The provider,
 *   model, endpoint, and declared capabilities all come from the profile;
 *   nothing here reads KUHN_AGENT_RUNTIME. The credential value is handed
 *   to the adapter constructor and dropped.
 * - no `profile` (legacy STH-47 path): the deployment selector picks
 *   'claude' (the `model` option) or the KUHN_PI_* preview.
 *
 * @param {object} [options] - the product-side runtime options
 *   ({ profile?, credential?, model, projectDir, tools, maxTurns,
 *   initialSessionId, systemPrompt })
 * @returns {object} AgentRuntime (contract.js): { identity, cancel(),
 *   runTurn(turn) } — normalized provider-runtime events only
 */
export function createAgentRuntime(options = {}) {
  if (options.profile) return createProfileRuntime(options);
  if (agentRuntimeKind() === 'pi') return createPiAgentRuntime(options);
  return createClaudeRuntime(options);
}

/** Every provider a profile may name (mirrors db/model-profiles.js PROVIDERS). */
export const PROFILE_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'openai-compatible'];

/** The pi-adapter model metadata a profile's declared capabilities map to. */
function declaredCapabilities(profile) {
  const caps = profile.capabilities ?? {};
  return {
    reasoning: caps.reasoning === true,
    input: Array.isArray(caps.input) && caps.input.length ? caps.input : ['text'],
    contextWindow: Number.isInteger(caps.contextWindow) ? caps.contextWindow : 128_000,
    maxTokens: Number.isInteger(caps.maxTokens) ? caps.maxTokens : 16_384,
  };
}

/**
 * Build the runtime a model profile describes. Every failure is a
 * configuration error that fails the task — never a fallback to another
 * profile or provider.
 */
function createProfileRuntime({
  profile, credential = {}, projectDir, tools = [], maxTurns, initialSessionId = null, systemPrompt = '',
}) {
  const provider = (profile.provider ?? '').toLowerCase();
  if (!PROFILE_PROVIDERS.includes(provider)) {
    throw new Error(
      `model profile '${profile.slug}': unknown provider '${profile.provider ?? '(unset)'}' `
      + `(expected: ${PROFILE_PROVIDERS.join(' | ')})`,
    );
  }
  const apiKey = credential.apiKey ?? null;
  if (provider === 'anthropic') {
    // A platform-declared Anthropic profile (issue #138) may name its own key
    // variable; the SDK subprocess otherwise inherits ANTHROPIC_API_KEY. The
    // value is read here and handed to the adapter only.
    const namedKey = !apiKey && credential.apiKeyEnv && credential.apiKeyEnv !== 'ANTHROPIC_API_KEY'
      ? (process.env[credential.apiKeyEnv] ?? null)
      : null;
    if (!apiKey && credential.apiKeyEnv && credential.apiKeyEnv !== 'ANTHROPIC_API_KEY' && !namedKey) {
      throw new Error(`model profile '${profile.slug}': the credential variable ${credential.apiKeyEnv} is not set`);
    }
    return createClaudeRuntime({
      model: profile.model_id ?? undefined, projectDir, tools, maxTurns, initialSessionId, apiKey: apiKey ?? namedKey,
    });
  }
  if (!profile.model_id) {
    throw new Error(`model profile '${profile.slug}': a model id is required`);
  }
  const apiKeyEnv = credential.apiKeyEnv ?? PI_DEFAULT_API_KEY_ENV[provider];
  const common = {
    modelId: profile.model_id, tools, systemPrompt, maxTurns,
    apiKey, apiKeyEnv, capabilities: declaredCapabilities(profile),
    // Explicit owner overrides apply even to catalogued models (e.g. a
    // smaller context window); the catalog entry supplies the rest.
    capabilityOverrides: profile.capability_overrides ?? null,
  };
  if (provider === 'openrouter') return createOpenRouterPiRuntime(common).runtime;
  if (provider === 'openai') return createOpenAIPiRuntime(common).runtime;
  if (provider === 'google') return createGooglePiRuntime(common).runtime;
  if (!profile.base_url) {
    throw new Error(`model profile '${profile.slug}': an OpenAI-compatible base URL is required`);
  }
  // The compatible path takes the declared metadata as top-level options. A
  // profile with no credential at all is a keyless local server: pi-ai then
  // sends a placeholder bearer instead of refusing the request.
  const { capabilities, capabilityOverrides: _o, ...rest } = common;
  const keyless = !apiKey && (profile.credential?.kind ?? 'none') === 'none';
  return createOpenAICompatiblePiRuntime({ baseUrl: profile.base_url, ...rest, ...capabilities, keyless }).runtime;
}

/**
 * Build the Pi preview runtime from the explicit configuration. Every
 * failure here is a configuration error that fails the task — never a
 * fallback to the Claude adapter.
 */
function createPiAgentRuntime({ tools = [], maxTurns, systemPrompt = '' } = {}) {
  const pi = config.agentRuntime?.pi ?? {};
  const provider = (pi.provider ?? '').toLowerCase();
  const apiKeyEnv = pi.apiKeyEnv || PI_DEFAULT_API_KEY_ENV[provider];
  if (!apiKeyEnv) {
    throw new Error(
      `Pi preview: unknown provider path '${provider || '(unset)'}' `
      + `(expected: ${Object.keys(PI_DEFAULT_API_KEY_ENV).join(' | ')})`,
    );
  }
  if (!pi.model) {
    throw new Error(
      'Pi preview: a Pi model id is required when the Pi runtime is selected '
      + '(set KUHN_PI_MODEL; Kuhn per-agent Claude model ids are not Pi model ids)',
    );
  }
  const common = { modelId: pi.model, tools, systemPrompt, maxTurns, apiKeyEnv };
  if (provider === 'openrouter') return createOpenRouterPiRuntime(common).runtime;
  if (provider === 'openai') return createOpenAIPiRuntime(common).runtime;
  if (provider === 'google') return createGooglePiRuntime(common).runtime;
  if (!pi.baseUrl) {
    throw new Error(
      "Pi preview: an OpenAI-compatible base URL is required for the 'openai-compatible' provider path (set KUHN_PI_BASE_URL)",
    );
  }
  return createOpenAICompatiblePiRuntime({ baseUrl: pi.baseUrl, ...common }).runtime;
}
