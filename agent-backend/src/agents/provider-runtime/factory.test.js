/**
 * AgentRuntime factory tests (STH-47 preview).
 *
 * The factory is the single provider-selection point: 'claude' (default)
 * builds the Claude adapter, 'pi' builds the Pi adapter from the explicit
 * preview configuration. Misconfigurations throw — they never fall back to
 * the other runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ config: {} }));
vi.mock('../../config.js', () => configMock);

import { AGENT_RUNTIME_KINDS, agentRuntimeKind, createAgentRuntime } from './factory.js';

function piConfig(overrides = {}) {
  return {
    kind: 'pi',
    pi: {
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b',
      baseUrl: '',
      apiKeyEnv: '',
      ...overrides,
    },
  };
}

beforeEach(() => {
  configMock.config = { agentRuntime: undefined };
});

describe('agentRuntimeKind', () => {
  it('defaults to claude when the selector is unset', () => {
    expect(agentRuntimeKind()).toBe('claude');
  });

  it('reads the explicit selector', () => {
    configMock.config = { agentRuntime: piConfig() };
    expect(agentRuntimeKind()).toBe('pi');
  });

  it('rejects an unknown kind instead of falling back', () => {
    configMock.config = { agentRuntime: { kind: 'piii', pi: {} } };
    expect(() => agentRuntimeKind()).toThrow(/Unknown agent runtime kind 'piii'/);
    expect(AGENT_RUNTIME_KINDS).toEqual(['claude', 'pi']);
  });
});

describe('createAgentRuntime', () => {
  it('builds the Claude adapter by default (no behavior change)', () => {
    const runtime = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' });
    expect(runtime.identity).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(typeof runtime.runTurn).toBe('function');
    expect(typeof runtime.cancel).toBe('function');
  });

  it('builds the Pi adapter with the explicit preview model, never the Kuhn model id', () => {
    configMock.config = { agentRuntime: piConfig() };
    // Kuhn's per-agent Claude model id is passed as before; the factory must
    // ignore it and use the explicit preview model.
    const runtime = createAgentRuntime({
      model: 'claude-opus-4-8',
      projectDir: '/p',
      tools: [],
      maxTurns: 50,
    });
    expect(runtime.identity).toMatchObject({
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b',
      api: 'openai-completions',
    });
    expect(typeof runtime.runTurn).toBe('function');
    expect(typeof runtime.cancel).toBe('function');
  });

  it('builds the OpenAI provider path when selected', () => {
    configMock.config = { agentRuntime: piConfig({ provider: 'openai', model: 'gpt-5-mini' }) };
    const runtime = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' });
    expect(runtime.identity).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('builds the OpenAI-compatible path with an explicit base URL and credential env', () => {
    configMock.config = {
      agentRuntime: piConfig({
        provider: 'openai-compatible',
        model: 'qwen-science',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKeyEnv: 'KUHN_TEST_VLLM_KEY',
      }),
    };
    const runtime = createAgentRuntime({ model: 'claude-haiku-4-5', projectDir: '/p' });
    expect(runtime.identity).toMatchObject({
      provider: 'openai-compatible',
      model: 'qwen-science',
      endpoint: 'http://127.0.0.1:8000/v1',
    });
  });

  it('fails the selection (no Claude fallback) when the Pi model is missing', () => {
    configMock.config = { agentRuntime: piConfig({ model: '' }) };
    expect(() => createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' }))
      .toThrow(/KUHN_PI_MODEL|Pi model id is required/);
  });

  it('fails the selection when the compatible path has no base URL', () => {
    configMock.config = {
      agentRuntime: piConfig({ provider: 'openai-compatible', model: 'm', baseUrl: '' }),
    };
    expect(() => createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' }))
      .toThrow(/KUHN_PI_BASE_URL/);
  });

  it('fails the selection on an unknown provider path', () => {
    configMock.config = { agentRuntime: piConfig({ provider: 'mistral' }) };
    expect(() => createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' }))
      .toThrow(/unknown provider path 'mistral'/);
  });

  it('never references ANTHROPIC_API_KEY when building the Pi runtime', () => {
    delete process.env.ANTHROPIC_API_KEY;
    configMock.config = { agentRuntime: piConfig() };
    const runtime = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' });
    expect(runtime.identity.provider).toBe('openrouter');
  });
});

/**
 * Option propagation through the real provider seam (STH-47 regressions):
 * the product's max-turn limit and the KUHN_PI_API_KEY_ENV credential name
 * must reach the runtime on EVERY live Pi provider path — not only the
 * faux and OpenAI-compatible paths.
 */
describe('createAgentRuntime pi option propagation (live paths)', () => {
  const LIVE_PATHS = [
    ['openrouter', { provider: 'openrouter', model: 'openai/gpt-oss-20b' }, 'OPENROUTER_API_KEY'],
    ['openai', { provider: 'openai', model: 'gpt-5-mini' }, 'OPENAI_API_KEY'],
    ['openai-compatible', {
      provider: 'openai-compatible', model: 'qwen-science', baseUrl: 'http://127.0.0.1:8000/v1',
    }, 'OPENAI_COMPATIBLE_API_KEY'],
  ];

  it.each(LIVE_PATHS)('propagates the product max-turn limit on the %s live path', (label, cfg) => {
    configMock.config = { agentRuntime: piConfig(cfg) };
    const runtime = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p', maxTurns: 50 });
    expect(runtime.identity).toMatchObject({ provider: cfg.provider, model: cfg.model });
    expect(runtime.maxTurns).toBe(50);
  });

  it.each(LIVE_PATHS)(
    'resolves the %s credential from the configured name only (no default-name fallback)',
    async (label, cfg, defaultEnv) => {
      const customEnv = `KUHN_S47_FACTORY_${label.toUpperCase().replace(/-/g, '_')}_KEY`;
      const savedCustom = process.env[customEnv];
      const savedDefault = process.env[defaultEnv];
      delete process.env[customEnv];
      delete process.env[defaultEnv];
      try {
        process.env[customEnv] = `sk-factory-${label}`;
        configMock.config = { agentRuntime: piConfig({ ...cfg, apiKeyEnv: customEnv }) };
        const runtime = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p', maxTurns: 25 });

        const auth = await runtime.models.getAuth(runtime.model);
        expect(auth).toMatchObject({ source: customEnv });
        expect(auth.auth.apiKey).toBe(`sk-factory-${label}`);
        expect(runtime.maxTurns).toBe(25);
        expect(JSON.stringify(runtime.identity)).not.toContain(`sk-factory-${label}`);

        // The provider's default credential name is never consulted as a
        // fallback when the configured name is unset (the pre-fix bug:
        // openai/openrouter ignored the configured name entirely).
        delete process.env[customEnv];
        process.env[defaultEnv] = `sk-ambient-${label}`;
        const unconfigured = createAgentRuntime({ model: 'claude-sonnet-4-6', projectDir: '/p' });
        expect(await unconfigured.models.getAuth(unconfigured.model)).toBeUndefined();
      } finally {
        if (savedCustom === undefined) delete process.env[customEnv];
        else process.env[customEnv] = savedCustom;
        if (savedDefault === undefined) delete process.env[defaultEnv];
        else process.env[defaultEnv] = savedDefault;
      }
    },
  );
});
