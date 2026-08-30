/**
 * Conformance harness runner (STH-5).
 *
 * Runs provider-neutral scenarios (scenario.js) against the production
 * runAgentTask() application contract with a pluggable driver (see
 * drivers/claude.js and drivers/pi.js). One driver per runtime; the same
 * scenario definitions run unchanged against both.
 *
 * The harness exercises REAL application code end to end: the real SQLite
 * database (in-memory), the real storage service (unique temp project roots),
 * the real pending-edit/reference/comment/job/conversation stores, and the
 * real app runtime (runAgentTask, reattach, question registry, retry loop,
 * budget accounting, teardown). Only the provider is replaced — by the
 * driver — and two networked services are faked from scenario fixtures
 * (search.js, sandbox.js) so no test ever spends quota or touches a Docker
 * daemon.
 *
 * The vitest test file is responsible for the vi.mock layer (it must be
 * hoisted): it mocks '@anthropic-ai/claude-agent-sdk' with mock-sdk.js,
 * '../config.js' with getConformanceConfig(), and the two network modules
 * with fixture-driven fakes that call setSearchFixture()/setSandboxFixture()
 * state.
 */
import { initDb } from '../../db/init.js';
import { getConformanceConfig } from './env.js';
import { querySync as dbQuery } from '../../db.js';
import { createProject } from '../../db/projects.js';
import { runAgentTask, reattach } from '../runtime.js';
import { deliverReply } from '../questions.js';
import { getRun } from '../runs.js';
import { insertOrgDocument, replaceDocumentChunks, setOrgDocumentStatus } from '../../db/org-documents.js';
import { validateScenario, scenarioHash, DEFAULT_SCENARIO_VERSION } from './scenario.js';
import { makeCtx } from './assertions.js';
import { createResultRecord, sha256Of, canonicalJson } from './result.js';
import { validateRuntimeEventSequence } from '../provider-runtime/contract.js';
import { validateContinuation } from '../provider-runtime/continuation.js';
import { installBridge, resetBridge } from './mock-sdk.js';
import { subscribeProjectEvents } from '../../project-events.js';

import {
  setSearchFixture,
  setSandboxFixture,
  setFetchFixture,
  installFetchFake,
} from './fakes.js';
import { seed } from '../../db/seed.js';

/** Seed the scenario fixture: org, user, project, files (inside AND outside
 * the project root), org documents, org agent-prompt additions, and agent
 * overrides. Returns { projectId, orgId, userId }. */
export async function seedFixture(fixture = {}) {
  const { join, dirname } = await import('node:path');
  const fs = await import('node:fs');

  // Default tenant (org + user) exists after initDb's seed; pin ids.
  const org = dbQuery("SELECT * FROM organizations WHERE slug = 'default' LIMIT 1").rows[0];
  const user = dbQuery('SELECT * FROM users ORDER BY id LIMIT 1').rows[0];
  const orgId = org.id;
  const userId = user.id;

  // Extra organizations (isolation scenarios).
  for (const o of fixture.orgs ?? []) {
    dbQuery('INSERT INTO organizations (name, slug, status) VALUES ($1, $2, $3)', [o.name, o.slug, o.status ?? 'active']);
  }

  const projectType = fixture.project?.type ?? 'manuscript';
  const projectName = fixture.project?.name ?? 'Conformance Project';
  // Canonical app path (storage root, slug, config all set by the module).
  const project = await createProject({ name: projectName, projectType, orgId });
  const projectId = project.id;

  // Active document persisted on the project config (STH-43 fallback).
  if (fixture.project?.activeDocument) {
    const cfg = { activeDocument: fixture.project.activeDocument };
    dbQuery('UPDATE projects SET config = $1 WHERE id = $2', [JSON.stringify(cfg), projectId]);
  }

  // Project files (through the real storage service).
  const { writeProjectFile, resolveProjectDir } = await import('../../storage.js');
  const projectDir = await resolveProjectDir(projectId);
  for (const [rel, content] of Object.entries(fixture.files ?? {})) {
    await writeProjectFile(projectId, rel, content);
  }
  // Files OUTSIDE the project root — reachable only by escaping it.
  // `rel` keys are plain relative paths under the outside root.
  const outsideRoot = join(projectDir, '..', '__outside__');
  for (const [rel, content] of Object.entries(fixture.outside ?? {})) {
    const abs = join(outsideRoot, rel);
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  // Symlinks inside the project pointing outside it. `target` is either a
  // path under the outside root (prefixed `__outside__/`) or a project-relative
  // path.
  for (const [linkName, target] of Object.entries(fixture.symlinks ?? {})) {
    const targetAbs = target.startsWith('__outside__/')
      ? join(outsideRoot, target.slice('__outside__/'.length))
      : join(projectDir, target);
    try { fs.rmSync(join(projectDir, linkName), { force: true }); } catch { /* fresh */ }
    fs.symlinkSync(targetAbs, join(projectDir, linkName));
  }

  // Org knowledge documents (real tables + FTS; search_org_knowledge is real).
  const { createHash } = await import('node:crypto');
  for (const doc of fixture.orgDocuments ?? []) {
    const chunks = (doc.chunks ?? []).map((c, i) => ({ seq: i + 1, headingPath: c.headingPath ?? null, text: c.text }));
    const body = chunks.map((c) => c.text).join('\n');
    const { document } = insertOrgDocument({
      orgId,
      filename: doc.filename ?? `${doc.title}.md`,
      title: doc.title,
      mime: 'text/markdown',
      sizeBytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
      source: doc.source ?? 'upload',
    });
    replaceDocumentChunks(document.id, chunks);
    setOrgDocumentStatus(orgId, document.id, 'ready');
  }

  // Org agent-prompt additions (issue #67).
  for (const p of fixture.orgAgentPrompts ?? []) {
    dbQuery(
      'INSERT INTO org_agent_prompts (org_id, agent_slug, addition) VALUES ($1, $2, $3)',
      [p.orgId ?? orgId, p.agentSlug, p.addition],
    );
  }

  // Agent overrides (defaults are the canonical seed matrix).
  for (const agent of fixture.agents ?? []) {
    const existing = dbQuery('SELECT id FROM agents WHERE slug = $1', [agent.slug]).rows[0];
    if (existing) {
      dbQuery(
        'UPDATE agents SET name = $1, system_prompt = $2, model = $3 WHERE slug = $4',
        [agent.name, agent.system_prompt, agent.model ?? null, agent.slug],
      );
      if (agent.tools) {
        dbQuery('DELETE FROM agent_tools WHERE agent_id = (SELECT id FROM agents WHERE slug = $1)', [agent.slug]);
        const agentId = dbQuery('SELECT id FROM agents WHERE slug = $1', [agent.slug]).rows[0].id;
        for (const toolSlug of agent.tools) {
          const toolId = dbQuery('SELECT id FROM tools WHERE slug = $1', [toolSlug]).rows[0]?.id;
          if (toolId != null) dbQuery('INSERT INTO agent_tools (agent_id, tool_id) VALUES ($1, $2)', [agentId, toolId]);
        }
      }
    } else {
      dbQuery(
        'INSERT INTO agents (slug, name, system_prompt, model) VALUES ($1, $2, $3, $4)',
        [agent.slug, agent.name, agent.system_prompt, agent.model ?? null],
      );
      if (agent.tools) {
        const agentId = dbQuery('SELECT id FROM agents WHERE slug = $1', [agent.slug]).rows[0].id;
        for (const toolSlug of agent.tools) {
          const toolId = dbQuery('SELECT id FROM tools WHERE slug = $1', [toolSlug]).rows[0]?.id;
          if (toolId != null) dbQuery('INSERT INTO agent_tools (agent_id, tool_id) VALUES ($1, $2)', [agentId, toolId]);
        }
      }
    }
  }

  return { projectId, orgId, userId, projectDir, outsideRoot };
}

/**
 * Reset the in-memory database between scenarios: wipe all rows, then
 * re-apply the idempotent seed (default tenant + canonical agent/tool
 * matrix). The in-memory DB is fresh per process; this keeps each scenario's
 * fixture isolated without reopening the connection.
 */
export async function resetDatabase() {
  const tables = dbQuery(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).rows.map((r) => r.name);
  // Fresh in-memory DB (no schema yet): apply schema + seed, then return.
  if (!tables.includes('projects')) {
    await initDb();
    return;
  }
  const ftsTables = dbQuery(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE %fts5%'",
  ).rows.map((r) => r.name);
  // FTS5 shadow tables (name_data, name_idx, ...) are internal — never
  // address them; the virtual table's 'delete-all' clears them too.
  const shadowPrefixes = ftsTables.map((t) => `${t}_`);
  dbQuery('PRAGMA foreign_keys = OFF');
  for (const t of tables) {
    if (shadowPrefixes.some((p) => t.startsWith(p))) continue;
    if (ftsTables.includes(t)) {
      dbQuery(`INSERT INTO "${t}"("${t}") VALUES ('delete-all')`);
    } else {
      dbQuery(`DELETE FROM "${t}"`);
    }
  }
  dbQuery('PRAGMA foreign_keys = ON');
  await seed();
}

/**
 * Run one scenario to completion.
 *
 * @param {object} scenario - a validated scenario definition
 * @param {(scenario: object) => object} driverFactory - createClaudeBridge |
 *   createPiBridge
 * @returns {Promise<object>} the result entry for this scenario
 */
export async function runScenario(scenarioInput, driverFactory) {
  // Scenario objects are module-level constants shared by every suite run in
  // this process (Claude suite, Pi suite, the parity reruns). Both the
  // production runtime (task.internal.budget accumulates .used / .baseWeight)
  // and the harness's token resolution (rewrites $first_comment_id into
  // tool args) mutate task data in place, and comment/job ids keep advancing
  // across scenarios (DELETE does not reset AUTOINCREMENT) — so a second run
  // of the same scenario would read stale, mutated state. Isolate every run
  // on its own data copy; the assert callback is shared by reference.
  const { assert, ...rest } = scenarioInput;
  const scenario = { ...structuredClone(rest), assert };
  const violations = [];
  const fail = (msg) => violations.push(msg);

  // Tool-argument token: '$first_comment_id' resolves to the id of the first
  // root comment in the scenario project (created by an earlier task). Lets
  // a later task's scripted turns reference an id the model would have read
  // from list_comments — without asserting provider-specific plumbing.
  // Drivers queue task.model references at factory time, so this mutates the
  // shared model object in place, right before the owning task starts.
  const COMMENT_TOKEN = '$first_comment_id';
  const SESSION_TOKEN = '$last_session';
  /** Resolve a task's `sessionId` token: '$last_session' becomes the
   * provider session id the most recent run reported on its `done` event.
   * Provider-neutral — the app reads session ids from provider messages and
   * re-publishes them on done; the harness never invents a session id. */
  const resolveSessionToken = (sessionId) => {
    if (sessionId !== SESSION_TOKEN) return sessionId;
    const lastDone = [...events].reverse().find((e) => e.type === 'done' && e.sessionId != null);
    if (!lastDone) {
      fail(`token ${SESSION_TOKEN} unresolved (no prior run reported a session id)`);
      return null;
    }
    return lastDone.sessionId;
  };
  const resolveModelTokens = (model) => {
    if (!JSON.stringify(model).includes(COMMENT_TOKEN)) return;
    const row = dbQuery(
      'SELECT id FROM comments WHERE project_id = $1 AND parent_id IS NULL ORDER BY id LIMIT 1',
      [fixture.projectId],
    ).rows[0];
    if (!row) {
      fail(`token ${COMMENT_TOKEN} unresolved (no root comment exists yet)`);
      return;
    }
    const walk = (value) => {
      if (value === COMMENT_TOKEN) return row.id;
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          value[k] = walk(v);
        }
        return value;
      }
      return value;
    };
    for (const attempt of model.attempts ?? []) {
      for (const turn of attempt.turns ?? []) {
        for (const call of turn.toolCalls ?? []) {
          if (call.args) call.args = walk(call.args);
        }
      }
    }
  };

  const scenarioViolations = validateScenario(scenario);
  if (scenarioViolations.length > 0) {
    return { id: scenario.id, ok: false, violations: scenarioViolations, objective: null, usage: null, latencyMs: null };
  }

  const started = Date.now();
  await resetDatabase();
  const fixture = await seedFixture(scenario.fixture ?? {});
  setSearchFixture({
    pmids: scenario.fixture?.literature?.pmids ?? {},
    searches: scenario.fixture?.literature?.searches ?? {},
    arxiv: scenario.fixture?.arxiv ?? {},
  });
  setSandboxFixture({ scripts: scenario.fixture?.scripts ?? {} });
  setFetchFixture({ pmids: scenario.fixture?.literature?.pmids ?? {} });
  installFetchFake();

  resetBridge();
  const driver = driverFactory(scenario);
  installBridge(driver);

  const events = [];       // every domain event, all tasks, in order
  const feed = [];         // would be the project feed envelopes (top-level)
  const runs = [];         // per root task: { index, role, jobId, terminal, latencyMs }
  const taskSignals = [];

  // ---- Run root tasks in order (dispatched children nest inside them) ----
  const rootTasks = scenario.tasks.map((t, i) => ({ ...t, _index: i })).filter((t) => t.dispatchedBy == null);
  const taskByIndex = new Map(scenario.tasks.map((t, i) => [i, t]));

  // The project event hub is the feed the web app renders; top-level runs
  // tee every channel event into it and the job-start marker lands there
  // right after createJob. Channel events like `text` carry no jobId of
  // their own, so the hub is how the harness binds each run to its job.
  let activeRun = null;
  const unsubscribeFeed = subscribeProjectEvents(fixture.projectId, (envelope) => {
    feed.push(envelope);
    if (envelope.type === 'job' && envelope.status === 'started' && envelope.jobId != null
      && activeRun && activeRun.jobId == null) {
      activeRun.jobId = envelope.jobId;
    }
  });

  for (const task of rootTasks) {
    const ac = new AbortController();
    taskSignals[task._index] = ac;
    if (task.model) resolveModelTokens(task.model);
    const appTask = {
      role: task.role,
      projectId: fixture.projectId,
      input: task.input,
      context: task.context ?? null,
      sessionId: resolveSessionToken(task.sessionId ?? null),
      compose: task.compose ?? false,
      seeding: task.seeding ?? false,
      userId: task.userId ?? fixture.userId,
      detachable: task.detachable ?? false,
      signal: ac.signal,
    };
    const internal = { budget: task.internal?.budget ?? undefined, depth: 0, parentJobId: null };

    const run = { index: task._index, role: task.role, jobId: null, terminal: 'none', latencyMs: null, interrupted: false };
    runs.push(run);
    activeRun = run;
    const t0 = Date.now();

    let interactionIdx = 0;
    const interactions = scenario.interactions ?? [];

    const gen = runAgentTask(appTask, internal);
    const consume = async (generator, { reattached = false } = {}) => {
      for await (const event of generator) {
        events.push(event);
        if (event.jobId != null) run.jobId = event.jobId;
        // Interactions fire once each, in declaration order, while consuming.
        while (interactionIdx < interactions.length) {
          const ix = interactions[interactionIdx];
          if (event.type !== ix.when) break;
          if (ix.match && !String(event.content ?? event.message ?? '').includes(ix.match)) break;
          interactionIdx += 1;
          if (ix.reply != null) {
            if (event.jobId != null) deliverReply(event.jobId, ix.reply);
            else violations.push(`interaction ${interactionIdx - 1}: no jobId to reply to`);
          } else if (ix.action === 'abort') {
            ac.abort();
            return;
          } else if (ix.action === 'disconnect') {
            return;
          }
        }
        if (event.type === 'done' || event.type === 'error') {
          run.terminal = event.type;
        }
      }
    };

    await consume(gen, {});

    // Detach-and-reconnect (story 027): a `disconnect` interaction while
    // parked on a question leaves the run alive; deliver the scenario's
    // reply once the re-attached stream re-emits the question card, then
    // consume to the end.
    if (run.terminal === 'none' && task.detachable && run.jobId != null) {
      const runHandle = getRun(run.jobId);
      if (runHandle) {
        const reply = scenario.reconnect?.reply ?? null;
        let replyDelivered = false;
        const gen2 = reattach(runHandle, ac.signal);
        for await (const event of gen2) {
          events.push(event);
          if (event.type === 'question' && reply != null && !replyDelivered) {
            deliverReply(run.jobId, reply);
            replyDelivered = true;
          }
          if (event.type === 'done' || event.type === 'error') run.terminal = event.type;
        }
        if (reply != null && !replyDelivered) {
          fail(`reconnect: reply was never delivered (no question re-emitted)`);
        }
      } else if (scenario.reconnect) {
        fail('reconnect: no live run handle (run was not left detachable)');
      }
    }

    run.latencyMs = Date.now() - t0;
    if (run.terminal === 'none' && !ac.signal.aborted) {
      // The run ended without a terminal event and was not interrupted by a
      // scripted disconnect/abort — record it; expectTerminal 'none' scenarios
      // (cancellation) are validated against the job status below.
    }
  }

  // Let queued microtasks (channel drains, question registry) settle.
  await new Promise((r) => setTimeout(r, 25));
  activeRun = null;
  unsubscribeFeed?.();

  // ---- Provider-level contract validation of every driver transcript ------
  for (const [qi, transcript] of driver.transcripts.entries()) {
    const seqViolations = validateRuntimeEventSequence(transcript);
    for (const v of seqViolations) {
      fail(`driver transcript ${qi} violates the provider contract: ${v}`);
    }
    const terminal = transcript[transcript.length - 1];
    if (terminal?.type === 'done' && terminal.continuation) {
      for (const v of validateContinuation(terminal.continuation)) {
        fail(`driver transcript ${qi} continuation is malformed: ${v}`);
      }
    }
  }

  // ---- Expected terminal + job status --------------------------------------
  const expectedTerminal = scenario.expectTerminal ?? 'done';
  for (const run of runs) {
    if (run.terminal !== expectedTerminal) {
      fail(`task ${run.index} (${run.role}): expected terminal '${expectedTerminal}', got '${run.terminal}'`);
    }
    if (run.jobId != null) {
      const job = ctxJob(run.jobId);
      if (!job) fail(`task ${run.index}: job ${run.jobId} missing from the database`);
      else {
        const expectedStatus = scenario.jobStatus
          ?? (expectedTerminal === 'done' ? 'done' : expectedTerminal === 'error' ? 'error' : 'cancelled');
        if (job.status !== expectedStatus) {
          fail(`task ${run.index}: job status '${job.status}' != expected '${expectedStatus}'`);
        }
      }
    }
  }

  // ---- Scenario assertions --------------------------------------------------
  const ctx = makeCtx({
    scenario,
    fixture,
    events,
    feed,
    driver,
    runs,
    violations,
  });
  if (typeof scenario.assert === 'function') {
    await scenario.assert(ctx);
  }

  // ---- Terminal-event usage (app-level, cross-driver comparable) ----------
  const doneEvents = events.filter((e) => e.type === 'done');
  const usage = doneEvents.length > 0
    ? {
        inputTokens: doneEvents.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0),
        outputTokens: doneEvents.reduce((n, e) => n + (e.usage?.outputTokens ?? 0), 0),
        budget: doneEvents.at(-1)?.budget ?? null,
      }
    : null;

  return {
    id: scenario.id,
    ok: violations.length === 0,
    violations,
    objective: {
      terminal: runs.map((r) => ({ index: r.index, role: r.role, terminal: r.terminal, jobId: r.jobId })),
      jobStatuses: runs.map((r) => (r.jobId != null ? ctxJob(r.jobId)?.status ?? null : null)),
      driverQueries: driver.observations.map((o) => ({
        role: o.role,
        sessionId: o.sessionId,
        model: o.model,
        resume: o.resume,
        attempt: o.attempt,
        interrupted: o.interrupted,
        mcpToolCount: o.mcpToolNames.length,
      })),
      messages: countMessages(),
    },
    events,
    bridge: driver,
    usage,
    latencyMs: Date.now() - started,
  };

  function ctxJob(id) {
    return dbQuery('SELECT * FROM jobs WHERE id = $1', [id]).rows[0] ?? null;
  }
  function countMessages() {
    const rows = dbQuery('SELECT role, COUNT(*) AS n FROM messages GROUP BY role').rows;
    return Object.fromEntries(rows.map((r) => [r.role, r.n]));
  }
}

/**
 * Run a whole suite and build the reproducible result record.
 *
 * @param {Array<object>} scenarios
 * @param {(scenario: object) => object} driverFactory
 * @returns {Promise<{ record: object, entries: Array<object> }>}
 */
export function runSuite(scenarios, driverFactory) {
  return (async () => {
    const entries = [];
    for (const scenario of scenarios) {
      const entry = await runScenario(scenario, driverFactory);
      entries.push(entry);
      // eslint-disable-next-line no-console
      console.log(`[conformance] ${entry.ok ? 'PASS' : 'FAIL'} ${entry.id}`
        + (entry.violations.length ? ` — ${entry.violations.join('; ')}` : ''));
    }
    const fixtureHash = sha256Of(canonicalJson({
      version: DEFAULT_SCENARIO_VERSION,
      scenarios: scenarios.map((s) => scenarioHash(s)),
    }));
    const record = createResultRecord({
      suite: 'conformance',
      runtime: driverFactory.name ?? 'unknown',
      provider: null,
      model: null,
      fixtures: { version: DEFAULT_SCENARIO_VERSION, hash: fixtureHash },
      config: {
        maxDispatchDepth: 2,
        questionTimeoutMs: 3000,
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        tokenBudget: 250000,
        budgetGrace: 1.1,
        modelWeights: { haiku: 1, sonnet: 3, opus: 5, default: 5 },
      },
      entries,
      extra: { scenarios: scenarios.map((s) => s.id) },
    });
    return { record, entries };
  })();
}
