/**
 * Application-level conformance harness — tests (STH-5).
 *
 * Runs the provider-neutral scenario suite against the production
 * runAgentTask() with two pluggable drivers:
 *   - the Claude SDK driver (the pre-migration runtime), and
 *   - the Pi driver (the phase-one provider-neutral runtime).
 *
 * Everything below the provider seam is REAL: the SQLite database (in-memory),
 * the storage service (unique temp roots), pending edits, references,
 * comments, jobs, conversations, org knowledge, the question registry, the
 * retry loop, budget accounting, and teardown. Only the model is scripted.
 * No scenario spends model quota or touches the network; the only networked
 * services (PubMed search/efetch, the Docker sandbox) are fixture-driven fakes.
 *
 * The same SCENARIOS array must pass under BOTH drivers — that is the
 * behavioral-contract claim the Pi migration must hold.
 *
 * A third "driver" (createBrokenClaudeBridge) deliberately breaks the runtime
 * contract (a query that never reports success); the harness MUST fail it.
 * That is the negative proof the suite can detect an incomplete runtime.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// --- vi.mock layer (hoisted; must not reference top-level bindings) --------

// The Claude SDK is replaced by the harness bridge registry. The active
// driver (installed per scenario by the harness) supplies query().
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const mock = await import('./mock-sdk.js');
  return {
    query: mock.query,
    tool: mock.tool,
    createSdkMcpServer: mock.createSdkMcpServer,
  };
});

// The Pi provider constructors (imported by the production runtime factory,
// provider-runtime/factory.js) are replaced by a scripted registry: the Pi
// driver installs its faux-runtime factory per scenario (mock-pi-adapter.js).
// Everything else the pi-adapter module exports (PiAgentRuntime,
// createFauxPiRuntime, the continuation converters) stays REAL — the harness
// runs the production Pi adapter end to end; only the model behind it is
// scripted.
vi.mock('../provider-runtime/pi-adapter.js', async () => {
  const original = await vi.importActual('../provider-runtime/pi-adapter.js');
  const mock = await import('./mock-pi-adapter.js');
  return {
    ...original,
    createOpenRouterPiRuntime: mock.scriptedPiFactory('openrouter'),
    createOpenAIPiRuntime: mock.scriptedPiFactory('openai'),
    createOpenAICompatiblePiRuntime: mock.scriptedPiFactory('openai-compatible'),
  };
});

// The budget-pause hand-off note (issue #110) is one Messages API call over
// the conversation tail (agents/handoff.js, covered by its own tests); the
// shared-budget scenario must not reach the network for it.
vi.mock('../handoff.js', () => ({
  captureBudgetHandoff: async () => ({ handoff: 'conformance hand-off note' }),
  captureHandoff: async () => ({ handoff: null }),
}));

// Pin the app config: in-memory DB, unique temp project roots, zero retry
// delays, 3-attempt retry budget, dispatch depth 2.
vi.mock('../../config.js', async () => {
  const { getConformanceConfig } = await import('./env.js');
  return { config: getConformanceConfig() };
});

// Literature search: the SEARCH entry points are fixture-driven (the
// networked queries the app runs); everything else in the module is REAL —
// parseArxivFeed, arxivFetchById, crossrefFetchByDoi — so the registry-fetch
// ingestion paths run for real against the fetch fake's Atom/Crossref feeds.
vi.mock('../search.js', async () => {
  const real = await vi.importActual('../search.js');
  const fakes = await import('./fakes.js');
  return {
    ...real,
    pubmedSearch: fakes.fakePubmedSearch,
    arxivSearch: fakes.fakeArxivSearch,
  };
});

// Docker sandbox — fixture-driven (scenario.fixture.scripts).
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

// --- Harness ----------------------------------------------------------------

import { initDb } from '../../db/init.js';
import { runSuite } from './harness.js';
import { restoreFetchFake } from './fakes.js';
import { createClaudeBridge } from './drivers/claude.js';
import { createPiDriver } from './drivers/pi.js';
import { createBrokenClaudeBridge } from './scenarios/broken.js';
import { SCENARIOS } from './scenarios/index.js';

function assertSuitePasses(name, entries) {
  for (const entry of entries) {
    expect(entry.violations, `${name} / ${entry.id}: ${entry.violations.join('; ')}`)
      .toEqual([]);
  }
}

describe('application conformance harness (STH-5)', () => {
  beforeAll(async () => {
    await initDb();
  }, 120_000);

  afterAll(() => {
    restoreFetchFake();
  });

  it('passes the full suite on the Claude driver', async () => {
    const { record, entries } = await runSuite(SCENARIOS, createClaudeBridge);
    assertSuitePasses('claude', entries);
    // The result record is reproducible: fixture version + hash are pinned.
    expect(record.fixtures.version).toBe('1.0.0');
    expect(record.fixtures.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.entries.length).toBe(SCENARIOS.length);
  }, 300_000);

  it('passes the full suite on the Pi driver', async () => {
    const { entries } = await runSuite(SCENARIOS, createPiDriver);
    assertSuitePasses('pi', entries);
  }, 300_000);

  it('reports identical objective results for both drivers', async () => {
    // The app-level observables (terminals, job statuses, usage) must be
    // driver-agnostic. The Pi driver reports usage through the same declared
    // per-turn tokens, so the totals match the Claude driver exactly.
    const claude = await runSuite(SCENARIOS, createClaudeBridge);
    const pi = await runSuite(SCENARIOS, createPiDriver);
    for (let i = 0; i < SCENARIOS.length; i += 1) {
      const a = claude.entries[i];
      const b = pi.entries[i];
      expect(a.objective?.terminal.map((t) => t.terminal), `${a.id}: terminals`)
        .toEqual(b.objective?.terminal.map((t) => t.terminal));
      expect(a.objective?.jobStatuses, `${a.id}: job statuses`)
        .toEqual(b.objective?.jobStatuses);
      expect(a.usage, `${a.id}: usage`).toEqual(b.usage);
    }
  }, 600_000);

  it('catches a deliberately broken runtime (negative proof)', async () => {
    // A runtime whose queries never report success must NOT pass: the app
    // ends the run without a terminal event and the job stuck in 'running'.
    const { entries } = await runSuite(SCENARIOS.slice(0, 4), createBrokenClaudeBridge);
    const failed = entries.filter((e) => !e.ok);
    expect(failed.length, 'a broken runtime must fail at least one scenario')
      .toBeGreaterThanOrEqual(1);
    const allViolations = entries.flatMap((e) => e.violations);
    expect(
      allViolations.some((v) => /expected terminal|job status/.test(v)),
      `the failure must be the missing terminal / stuck job: ${allViolations.join('; ')}`,
    ).toBe(true);
  }, 120_000);
});
