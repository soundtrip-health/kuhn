/**
 * Application conformance over the wire (issue #112): the full scenario
 * suite on the REAL OpenAI-compatible Pi runtime talking HTTP to a scripted
 * chat-completions server (fake-openai-server.js), through the production
 * runtime factory's profile path. This is the proof that an OpenAI-compatible
 * endpoint (vLLM / Ollama / LiteLLM, and the OpenRouter path, which shares
 * the same pi-ai completions client) preserves Kuhn's application contract
 * with configuration only — nothing between the product seam and the socket
 * is replaced.
 *
 * Mocks mirror conformance.test.js: the Claude SDK (unused here but imported
 * by the Claude adapter the parity run needs), the Pi provider constructors
 * (the compatible one is captured so the HTTP driver can build the real
 * runtime), the hand-off capture, config, literature search, and the sandbox.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const mock = await import('./mock-sdk.js');
  return { query: mock.query, tool: mock.tool, createSdkMcpServer: mock.createSdkMcpServer };
});

const realAdapter = vi.hoisted(() => ({ createOpenAICompatiblePiRuntime: null }));
vi.mock('../provider-runtime/pi-adapter.js', async () => {
  const original = await vi.importActual('../provider-runtime/pi-adapter.js');
  const mock = await import('./mock-pi-adapter.js');
  realAdapter.createOpenAICompatiblePiRuntime = original.createOpenAICompatiblePiRuntime;
  return {
    ...original,
    createOpenRouterPiRuntime: mock.scriptedPiFactory('openrouter'),
    createOpenAIPiRuntime: mock.scriptedPiFactory('openai'),
    createOpenAICompatiblePiRuntime: mock.scriptedPiFactory('openai-compatible'),
  };
});

vi.mock('../handoff.js', () => ({
  captureBudgetHandoff: async () => ({ handoff: 'conformance hand-off note' }),
  captureHandoff: async () => ({ handoff: null }),
}));

vi.mock('../../config.js', async () => {
  const { getConformanceConfig } = await import('./env.js');
  return { config: getConformanceConfig() };
});

vi.mock('../search.js', async () => {
  const real = await vi.importActual('../search.js');
  const fakes = await import('./fakes.js');
  return { ...real, pubmedSearch: fakes.fakePubmedSearch, arxivSearch: fakes.fakeArxivSearch };
});

vi.mock('../../sandbox.js', async () => {
  const fakes = await import('./fakes.js');
  return {
    SandboxError: fakes.SandboxError,
    RUNNABLE_LANGUAGES: ['R'],
    runScriptSandboxed: fakes.fakeRunScriptSandboxed,
    buildDockerArgs: vi.fn(),
    runSandboxed: vi.fn(),
    renderTypstPdf: vi.fn(),
    pandocConvert: vi.fn(),
  };
});

import { initDb } from '../../db/init.js';
import { runSuite } from './harness.js';
import { restoreFetchFake } from './fakes.js';
import { createClaudeBridge } from './drivers/claude.js';
import { createPiHttpDriver, piHttpRequests, startPiHttpDriver, stopPiHttpDriver } from './drivers/pi-http.js';
import { SCENARIOS } from './scenarios/index.js';

function assertSuitePasses(name, entries) {
  for (const entry of entries) {
    expect(entry.violations, `${name} / ${entry.id}: ${entry.violations.join('; ')}`).toEqual([]);
  }
}

describe('application conformance over HTTP — OpenAI-compatible endpoint (issue #112)', () => {
  beforeAll(async () => {
    await initDb();
    await startPiHttpDriver({ createOpenAICompatiblePiRuntime: realAdapter.createOpenAICompatiblePiRuntime });
  }, 120_000);

  afterAll(async () => {
    restoreFetchFake();
    await stopPiHttpDriver();
  });

  it('passes the full suite on the real OpenAI-compatible runtime over real HTTP', async () => {
    const { entries } = await runSuite(SCENARIOS, createPiHttpDriver);
    assertSuitePasses('pi-http', entries);
    // The last scenario's requests are still on the server: every one went
    // over the wire as a streamed chat completion with the bearer the
    // profile path resolved, never a real-looking env credential.
    const requests = piHttpRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.stream && r.authorization === 'Bearer conformance-test-key')).toBe(true);
  }, 600_000);

  it('reports identical objective results to the Claude driver', async () => {
    const claude = await runSuite(SCENARIOS, createClaudeBridge);
    const http = await runSuite(SCENARIOS, createPiHttpDriver);
    for (let i = 0; i < SCENARIOS.length; i += 1) {
      const a = claude.entries[i];
      const b = http.entries[i];
      expect(a.objective?.terminal.map((t) => t.terminal), `${a.id}: terminals`)
        .toEqual(b.objective?.terminal.map((t) => t.terminal));
      expect(a.objective?.jobStatuses, `${a.id}: job statuses`).toEqual(b.objective?.jobStatuses);
      expect(a.usage, `${a.id}: usage`).toEqual(b.usage);
    }
  }, 900_000);
});
