/**
 * Connectivity probe for a model profile (issue #111/#112): one synthetic
 * turn — no tools, no project content, a fixed instruction — through the
 * real runtime factory, so an owner can check that a provider, model,
 * endpoint, and credential work before routing an agent to them.
 *
 * The result never carries the credential: the resolved value goes into the
 * adapter constructor and nothing else; any provider error text is scrubbed
 * of it defensively before it is returned.
 */

import { tmpdir } from 'node:os';

import { config } from '../config.js';
import { createAgentRuntime } from './provider-runtime/factory.js';
import { validateRuntimeEventSequence } from './provider-runtime/contract.js';
import { resolveCredential } from './model-routing.js';

export const PROBE_MARKER = 'KUHN_OK';
const PROBE_SYSTEM_PROMPT = 'You are a connectivity check for a scientific-writing tool. Follow the user instruction exactly and add nothing.';
const PROBE_INPUT = `Reply with exactly ${PROBE_MARKER}`;

function scrub(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('[redacted]');
}

/**
 * @param {number|null} orgId
 * @param {object} profile - a profile from db/model-profiles.js
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>} { ok, provider, model, api, endpoint, latency_ms,
 *   marker_seen, usage, contract_violations, error? } — never the credential
 */
export async function probeProfile(orgId, profile, { timeoutMs = config.agentRuntime?.testTimeoutMs ?? 30_000 } = {}) {
  const started = Date.now();
  const base = {
    ok: false,
    provider: profile.provider ?? null,
    model: profile.model_id ?? null,
    endpoint: profile.endpoint ?? null,
    api: null,
    latency_ms: 0,
    marker_seen: false,
    usage: null,
    contract_violations: [],
  };
  let credential;
  try {
    credential = resolveCredential(orgId, profile);
  } catch (err) {
    return { ...base, latency_ms: Date.now() - started, error: { code: 'credential_missing', message: err.message } };
  }
  const secret = credential.apiKey ?? null;
  let runtime;
  try {
    runtime = createAgentRuntime({
      profile, credential, tools: [], maxTurns: 1, projectDir: tmpdir(), systemPrompt: PROBE_SYSTEM_PROMPT,
    });
  } catch (err) {
    return { ...base, latency_ms: Date.now() - started, error: { code: 'configuration', message: scrub(err.message, secret) } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`probe timed out after ${timeoutMs} ms`)), timeoutMs);
  const events = [];
  try {
    for await (const event of runtime.runTurn({ input: PROBE_INPUT, signal: controller.signal, systemPrompt: PROBE_SYSTEM_PROMPT })) {
      events.push(event);
    }
  } catch (err) {
    clearTimeout(timer);
    return { ...base, latency_ms: Date.now() - started, error: { code: 'runtime', message: scrub(err.message, secret) } };
  } finally {
    clearTimeout(timer);
    runtime.cancel?.();
  }
  const identity = events.find((e) => e.type === 'provider') ?? {};
  const terminal = events.at(-1);
  const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('\n');
  const result = {
    ...base,
    provider: identity.provider ?? base.provider,
    model: identity.model ?? base.model,
    api: identity.api ?? null,
    endpoint: identity.endpoint ?? base.endpoint,
    latency_ms: Date.now() - started,
    marker_seen: text.includes(PROBE_MARKER),
    usage: terminal?.usage ?? null,
    contract_violations: validateRuntimeEventSequence(events),
  };
  if (terminal?.type === 'done') {
    result.ok = result.contract_violations.length === 0;
    if (!result.marker_seen) {
      result.warning = 'The model answered but did not return the expected marker; check that the model id is a chat model that follows instructions.';
    }
    return result;
  }
  const error = terminal?.error ?? { code: 'no_terminal', message: 'the runtime ended without a terminal event' };
  return { ...result, error: { code: error.code ?? 'provider_error', message: scrub(error.message ?? String(error), secret) } };
}
