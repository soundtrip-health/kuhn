// Live multi-provider matrix (issue #112). For every provider path that has
// a credential in the environment, run ONE bounded, tool-using turn through
// the production runtime factory from a model profile — the same code path
// an org profile takes — and check the normalized contract, the tool call,
// and the final marker. Paths without credentials are skipped, never faked.
//
//   OPENROUTER_API_KEY            → openrouter   (KUHN_MATRIX_OPENROUTER_MODEL, default openai/gpt-oss-20b)
//   OPENAI_API_KEY                → openai       (KUHN_MATRIX_OPENAI_MODEL, default gpt-5-mini)
//   KUHN_MATRIX_BASE_URL          → openai-compatible (KUHN_MATRIX_MODEL required;
//                                    KUHN_MATRIX_API_KEY_ENV names the key variable, or none for a keyless server)
//   ANTHROPIC_API_KEY             → anthropic    (KUHN_MATRIX_ANTHROPIC_MODEL, default claude-haiku-4-5)
//
//   npm run smoke:provider-matrix
//
// Uses real model quota on each configured path (one short turn each).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentRuntime } from '../src/agents/provider-runtime/factory.js';
import { validateRuntimeEventSequence } from '../src/agents/provider-runtime/contract.js';

const MARKER = 'KUHN_MATRIX_OK';
const env = process.env;

/** One neutral Kuhn-style tool the model must call before answering. */
function echoTool(calls) {
  return {
    name: 'kuhn_echo',
    grants: ['kuhn_echo'],
    readOnly: true,
    effect: 'none',
    description: 'Echo a short string back. Call this exactly once with the word the user gives you.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
    execute: async (_id, args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: `echo:${args.word}` }] };
    },
  };
}

const PATHS = [
  {
    provider: 'openrouter', ready: () => Boolean(env.OPENROUTER_API_KEY),
    profile: () => ({ slug: 'matrix-openrouter', provider: 'openrouter', model_id: env.KUHN_MATRIX_OPENROUTER_MODEL || 'openai/gpt-oss-20b', capabilities: {}, credential: { kind: 'deployment', env: 'OPENROUTER_API_KEY' }, endpoint: 'https://openrouter.ai/api/v1' }),
    credential: () => ({ apiKeyEnv: 'OPENROUTER_API_KEY' }),
  },
  {
    provider: 'openai', ready: () => Boolean(env.OPENAI_API_KEY),
    profile: () => ({ slug: 'matrix-openai', provider: 'openai', model_id: env.KUHN_MATRIX_OPENAI_MODEL || 'gpt-5-mini', capabilities: {}, credential: { kind: 'deployment', env: 'OPENAI_API_KEY' }, endpoint: 'https://api.openai.com/v1' }),
    credential: () => ({ apiKeyEnv: 'OPENAI_API_KEY' }),
  },
  {
    provider: 'openai-compatible', ready: () => Boolean(env.KUHN_MATRIX_BASE_URL && env.KUHN_MATRIX_MODEL),
    profile: () => ({ slug: 'matrix-compatible', provider: 'openai-compatible', model_id: env.KUHN_MATRIX_MODEL, base_url: env.KUHN_MATRIX_BASE_URL, capabilities: { contextWindow: parseInt(env.KUHN_MATRIX_CONTEXT_WINDOW || '32768'), maxTokens: 4096 }, credential: env.KUHN_MATRIX_API_KEY_ENV ? { kind: 'deployment', env: env.KUHN_MATRIX_API_KEY_ENV } : { kind: 'none' }, endpoint: env.KUHN_MATRIX_BASE_URL }),
    credential: () => (env.KUHN_MATRIX_API_KEY_ENV ? { apiKeyEnv: env.KUHN_MATRIX_API_KEY_ENV } : {}),
  },
  {
    provider: 'anthropic', ready: () => Boolean(env.ANTHROPIC_API_KEY),
    profile: () => ({ slug: 'matrix-anthropic', provider: 'anthropic', model_id: env.KUHN_MATRIX_ANTHROPIC_MODEL || 'claude-haiku-4-5', capabilities: {}, credential: { kind: 'deployment' }, endpoint: 'https://api.anthropic.com' }),
    credential: () => ({}),
  },
];

async function runPath(path) {
  const calls = [];
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('matrix turn timed out')), 120_000);
  const events = [];
  try {
    const runtime = createAgentRuntime({
      profile: path.profile(),
      credential: path.credential(),
      tools: [echoTool(calls)],
      maxTurns: 4,
      projectDir: mkdtempSync(join(tmpdir(), 'kuhn-matrix-')),
      systemPrompt: 'You are a connectivity check. Use the kuhn_echo tool exactly once with the word the user gives, then reply with exactly the tool output and nothing else.',
    });
    for await (const event of runtime.runTurn({
      input: `Call kuhn_echo with the word ${MARKER}, then reply with only the tool output.`,
      signal: controller.signal,
      systemPrompt: 'You are a connectivity check. Use the kuhn_echo tool exactly once with the word the user gives, then reply with exactly the tool output and nothing else.',
    })) {
      events.push(event);
    }
  } catch (err) {
    return { provider: path.provider, ok: false, error: err.message, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
  const identity = events.find((e) => e.type === 'provider') ?? {};
  const terminal = events.at(-1);
  const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('\n');
  const violations = validateRuntimeEventSequence(events);
  const toolCalled = calls.some((c) => String(c.word ?? '').includes(MARKER));
  const ok = terminal?.type === 'done' && violations.length === 0 && toolCalled && text.includes(MARKER);
  return {
    provider: identity.provider ?? path.provider,
    model: identity.model ?? null,
    endpoint: identity.endpoint ?? null,
    api: identity.api ?? null,
    ok,
    terminal: terminal?.type === 'done' ? 'done' : `${terminal?.type}:${terminal?.error?.code ?? '?'}`,
    tool_called: toolCalled,
    marker_seen: text.includes(MARKER),
    contract_violations: violations,
    usage: terminal?.usage ?? null,
    latency_ms: Date.now() - started,
    ...(terminal?.type === 'error' ? { error: terminal.error?.message } : {}),
  };
}

const results = [];
for (const path of PATHS) {
  if (!path.ready()) {
    results.push({ provider: path.provider, skipped: true, reason: 'no credential / configuration in the environment' });
    continue;
  }
  console.log(`[matrix] ${path.provider}: running one tool-using turn…`);
  results.push(await runPath(path));
}
console.log(JSON.stringify(results, null, 2));
const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
console.log(`[matrix] ${ran.length} path(s) ran, ${failed.length} failed, ${results.length - ran.length} skipped`);
if (failed.length) process.exit(1);
