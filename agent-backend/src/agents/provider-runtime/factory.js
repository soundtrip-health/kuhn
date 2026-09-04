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
  createOpenAICompatiblePiRuntime,
  createOpenAIPiRuntime,
  createOpenRouterPiRuntime,
} from './pi-adapter.js';

export const AGENT_RUNTIME_KINDS = ['claude', 'pi'];

/** Default credential environment variable per Pi provider path. */
const PI_DEFAULT_API_KEY_ENV = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
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
 * @param {object} [options] - the product-side runtime options
 *   ({ model, projectDir, tools, maxTurns, initialSessionId })
 * @returns {object} AgentRuntime (contract.js): { identity, cancel(),
 *   runTurn(turn) } — normalized provider-runtime events only
 */
export function createAgentRuntime(options = {}) {
  if (agentRuntimeKind() === 'pi') return createPiAgentRuntime(options);
  return createClaudeRuntime(options);
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
  if (!pi.baseUrl) {
    throw new Error(
      "Pi preview: an OpenAI-compatible base URL is required for the 'openai-compatible' provider path (set KUHN_PI_BASE_URL)",
    );
  }
  return createOpenAICompatiblePiRuntime({ baseUrl: pi.baseUrl, ...common }).runtime;
}
