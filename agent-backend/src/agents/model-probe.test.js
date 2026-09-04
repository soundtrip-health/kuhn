// Connectivity probe (issue #111/#112): one synthetic turn through the
// factory with a scripted runtime — success, provider failure with the
// credential scrubbed, configuration failure, and the timeout.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const factoryState = vi.hoisted(() => ({ build: null, lastOptions: null }));
vi.mock('./provider-runtime/factory.js', () => ({
  createAgentRuntime: vi.fn((options) => {
    factoryState.lastOptions = options;
    return factoryState.build(options);
  }),
}));
vi.mock('./model-routing.js', () => ({
  resolveCredential: vi.fn(() => ({ apiKey: 'sk-secret-value' })),
}));
vi.mock('../config.js', () => ({ config: { agentRuntime: { testTimeoutMs: 200 } } }));

import { probeProfile, PROBE_MARKER } from './model-probe.js';
import { resolveCredential } from './model-routing.js';

const profile = { slug: 'p', provider: 'openrouter', model_id: 'm', endpoint: 'https://openrouter.ai/api/v1', credential: { kind: 'secret', secret: 's' } };

function scripted(events) {
  return () => ({
    identity: { provider: 'openrouter', model: 'm', api: 'openai-completions', endpoint: 'https://openrouter.ai/api/v1' },
    cancel: vi.fn(),
    async* runTurn() { for (const e of events) yield e; },
  });
}
const identity = { type: 'provider', provider: 'openrouter', model: 'm', api: 'openai-completions', endpoint: 'https://openrouter.ai/api/v1' };

const done = (usage = {}) => ({ type: 'done', stopReason: 'stop', usage, continuation: { version: 1, messages: [] } });

beforeEach(() => {
  vi.clearAllMocks();
  factoryState.lastOptions = null;
  resolveCredential.mockReturnValue({ apiKey: 'sk-secret-value' });
});

describe('probeProfile', () => {
  it('reports ok with identity, usage, and the marker on a clean turn — no tools, no project content', async () => {
    factoryState.build = scripted([
      identity,
      { type: 'text', content: `${PROBE_MARKER}` },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      done({ inputTokens: 5, outputTokens: 2 }),
    ]);
    const result = await probeProfile(1, profile);
    expect(result).toMatchObject({
      ok: true, provider: 'openrouter', model: 'm', api: 'openai-completions',
      endpoint: 'https://openrouter.ai/api/v1', marker_seen: true, usage: { inputTokens: 5, outputTokens: 2 }, contract_violations: [],
    });
    expect(result.error).toBeUndefined();
    expect(factoryState.lastOptions).toMatchObject({ profile, credential: { apiKey: 'sk-secret-value' }, tools: [], maxTurns: 1 });
    expect(JSON.stringify(result)).not.toContain('sk-secret-value');
  });

  it('warns when the model answers without the marker', async () => {
    factoryState.build = scripted([identity, { type: 'text', content: 'hello' }, done()]);
    const result = await probeProfile(1, profile);
    expect(result.ok).toBe(true);
    expect(result.marker_seen).toBe(false);
    expect(result.warning).toMatch(/expected marker/);
  });

  it('returns the provider error with the credential scrubbed', async () => {
    factoryState.build = scripted([
      identity,
      { type: 'error', error: { code: 'auth', message: 'Unauthorized: key sk-secret-value rejected', retryable: false }, usage: {} },
    ]);
    const result = await probeProfile(1, profile);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'auth', message: 'Unauthorized: key [redacted] rejected' });
  });

  it('reports a configuration failure when the runtime cannot be built', async () => {
    factoryState.build = () => { throw new Error('model profile p: a model id is required (sk-secret-value)'); };
    const result = await probeProfile(1, profile);
    expect(result.error).toEqual({ code: 'configuration', message: 'model profile p: a model id is required ([redacted])' });
  });

  it('reports a missing credential without building a runtime', async () => {
    resolveCredential.mockImplementation(() => { throw new Error("the credential secret 's' is missing"); });
    const result = await probeProfile(1, profile);
    expect(result.error.code).toBe('credential_missing');
    expect(factoryState.lastOptions).toBeNull();
  });

  it('aborts a hung provider at the timeout', async () => {
    factoryState.build = () => ({
      identity: {},
      cancel: vi.fn(),
      async* runTurn({ signal }) {
        yield identity;
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
        yield { type: 'error', error: { code: 'cancelled', message: String(signal.reason?.message ?? 'aborted'), retryable: false }, usage: {} };
      },
    });
    const result = await probeProfile(1, profile, { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('cancelled');
    expect(result.error.message).toMatch(/timed out after 20 ms/);
  });
});
