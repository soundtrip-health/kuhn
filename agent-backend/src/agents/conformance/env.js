/**
 * Conformance harness configuration (STH-5 / STH-31).
 *
 * The vitest test file pins Kuhn's config.js with a vi.mock whose factory
 * returns getConformanceConfig(). The factory is hoisted above all imports,
 * so the config must be constructible without importing any Kuhn module —
 * it only allocates a unique temporary data directory. Every harness run
 * gets its own KUHN_DATA_DIR-equivalent (in-memory SQLite + temp project
 * file roots) so the harness never touches another contributor's data or
 * processes.
 *
 * The agent knobs are pinned to the values the scenarios reason about:
 * dispatch depth 2, a short ask_user timeout, a 3-attempt retry budget with
 * zero delay (so the backoff path runs instantly), and the standard model
 * cost weights.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached = null;

/**
 * The pinned conformance configuration. Module singleton: the vi.mock
 * factory and the harness import the same instance, so the project file
 * roots the config points at are the ones the fixture seeding writes to.
 */
export function getConformanceConfig() {
  if (cached) return cached;
  const dataDir = mkdtempSync(join(tmpdir(), 'kuhn-conformance-'));
  cached = {
    db: { path: ':memory:' },
    history: { enabled: false },
    agent: {
      tokenBudget: 250000,
      budgetGrace: 1.1,
      maxDispatchDepth: 2,
      questionTimeoutMs: 3000,
      model: undefined,
      modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 },
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      // Context-meter denominator fallback (STH-52), mirroring main's default.
      contextWindow: 200000,
      projectsRoot: join(dataDir, 'files'),
    },
    storage: {
      orgsRoot: join(dataDir, 'orgs'),
      maxFileBytes: 10 * 1024 * 1024,
    },
    // The real project-events hub runs in these tests (the channel tee
    // publishes into it); subscribing to it needs this cap.
    projectEvents: { maxSubscribers: 25 },
    // file_events retention cap (recordFileEvent prunes on insert).
    fileActivity: { maxEventsPerProject: 1000 },
    sandbox: { script: { maxConcurrent: 2 } },
  // Catalog manifests live outside the data dir in a real checkout; point at
  // empty temp dirs so the idempotent seed no-ops (manifest ENOENT) instead
  // of touching the repo's guidance/script catalogs.
    knowledge: { catalogRoot: join(dataDir, 'knowledge-catalog') },
    scripts: { catalogRoot: join(dataDir, 'scripts-catalog') },
    slideThemes: {
      catalogRoot: join(dataDir, 'slide-themes-catalog'),
      maxThemeBytes: 256 * 1024,
    },
    auth: { superadminEmails: [] },
    // Runtime selector (STH-47): 'claude' by default; the Pi conformance
    // driver switches this to 'pi' for its suite run and the harness resets
    // it per scenario. The pi preview config here is the driver's — the
    // production env-driven values (KUHN_PI_*) never apply in harness runs.
    agentRuntime: { kind: 'claude', pi: { provider: '', model: '', baseUrl: '', apiKeyEnv: '' } },
    dataDir,
  };
  return cached;
}
