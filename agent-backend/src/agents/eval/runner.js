/**
 * Quality-baseline runner (STH-31).
 *
 * Drives the production runAgentTask() with a REAL model (opt-in — the
 * runner refuses to run without ANTHROPIC_API_KEY) against fixture
 * projects composed from the synthetic corpus. Everything around the model
 * is real application code: the real SQLite database (a throwaway file DB
 * under a unique temp KUHN_DATA_DIR), the real storage service, the real
 * reference/comment/job/conversation stores, the real retry/budget/teardown
 * paths. The only fakes are the two networked services, intercepted at
 * globalThis.fetch (network.js) from the corpus literature fixture — so a
 * run is deterministic, reproducible, and spends no provider quota beyond
 * the model calls themselves.
 *
 * Observations are collected from Kuhn-owned state (DB tables, project
 * files, channel events) — never from provider message internals — so the
 * same runner will work unchanged against the Pi runtime once it is
 * registered (run.js --runtime).
 *
 * Ordinary tests never import this module's execution path: eval.test.js
 * exercises the corpus, cases, checks, and the network fakes without a
 * model.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

import { querySync as dbQuery } from '../../db.js';
import { runAgentTask } from '../runtime.js';
import { deliverReply } from '../questions.js';
import { resetDatabase, seedFixture } from '../conformance/harness.js';
import { resolveProjectDir } from '../../storage.js';
import { normalizeToolName, runChecks } from './checks.js';
import { composeCaseFixture } from './corpus.js';
import { installEvalNetwork } from './network.js';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.bib', '.csv', '.tsv', '.json', '.js', '.mjs', '.r', '.py', '.tex', '.yml', '.yaml']);
const MAX_TEXT_BYTES = 200 * 1024;

/** Walk the project root; return { [relPath]: content } for text files. */
async function readProjectFiles(projectId) {
  const dir = await resolveProjectDir(projectId);
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(dir, abs).split(join).join('/');
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        const st = statSync(abs);
        if (TEXT_EXTENSIONS.has(ext) && st.size <= MAX_TEXT_BYTES) {
          try {
            out[rel] = readFileSync(abs, 'utf-8');
          } catch { /* binary or unreadable — not a text fixture */ }
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Per-role tool-call observation from the messages table (tool_use blocks). */
function collectToolCalls(projectId) {
  const toolErrors = new Set(
    dbQuery('SELECT tool_call_id FROM messages WHERE project_id = $1 AND role = $2 AND is_error = 1', [projectId, 'tool'])
      .rows.map((r) => r.tool_call_id),
  );
  const byRole = {};
  for (const row of dbQuery(
    'SELECT m.tool_calls, c.agent_slug FROM messages m ' +
      'JOIN conversations c ON c.id = m.conversation_id ' +
      'WHERE m.project_id = $1 AND m.role = $2 AND m.tool_calls IS NOT NULL ORDER BY m.id',
    [projectId, 'assistant'],
  ).rows) {
    const role = row.agent_slug ?? 'unknown';
    let blocks;
    try {
      blocks = JSON.parse(row.tool_calls);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_use' && block?.name == null) continue;
      byRole[role] ??= [];
      byRole[role].push({
        name: normalizeToolName(block.name),
        args: block.input ?? block.args ?? null,
        isError: block.id != null && toolErrors.has(block.id),
      });
    }
  }
  return byRole;
}

/** The role's granted tool slugs from the DB matrix. */
function grantedToolsFor(role) {
  return dbQuery(
    'SELECT t.slug FROM agent_tools at ' +
      'JOIN agents a ON a.id = at.agent_id ' +
      'JOIN tools t ON t.id = at.tool_id ' +
      'WHERE a.slug = $1',
    [role],
  ).rows.map((r) => r.slug);
}

/**
 * Collect the observation snapshot for one finished case run.
 * @param {object} caseDef - the case definition
 * @param {object} corpus - loadCorpus()
 * @param {object} fixture - seedFixture() result
 * @param {object} caseFixture - composeCaseFixture() result
 * @param {object} drive - { events, qa, terminal } from driveCase()
 */
async function buildObservation(caseDef, corpus, fixture, caseFixture, drive) {
  const { projectId } = fixture;
  const files = await readProjectFiles(projectId);
  const originalFiles = { ...caseFixture.files };

  const toolCallsByRole = collectToolCalls(projectId);
  const references = dbQuery(
    'SELECT cite_key, pmid, title, source_type FROM bib_references WHERE project_id = $1 ORDER BY id',
    [projectId],
  ).rows;
  const bibText = {};
  for (const path of new Set(['draft/references.bib', ...Object.keys(files).filter((p) => p.endsWith('.bib'))])) {
    if (files[path] != null) bibText[path] = files[path];
  }
  const comments = dbQuery(
    'SELECT id, path, anchor_quote AS quote, body, parent_id FROM comments WHERE project_id = $1 ORDER BY id',
    [projectId],
  ).rows;
  const projectRow = dbQuery('SELECT config FROM projects WHERE id = $1', [projectId]).rows[0];
  const projectConfig = projectRow?.config ? JSON.parse(projectRow.config) : null;
  const jobs = dbQuery(
    'SELECT id, role, status, parent_job_id, input_tokens, output_tokens, error FROM jobs WHERE project_id = $1 ORDER BY id',
    [projectId],
  ).rows;

  const assistantRows = dbQuery(
    'SELECT m.content, c.agent_slug FROM messages m ' +
      'JOIN conversations c ON c.id = m.conversation_id ' +
      'WHERE m.project_id = $1 AND m.role = $2 AND m.content IS NOT NULL ORDER BY m.id',
    [projectId, 'assistant'],
  ).rows;
  const allText = assistantRows.map((r) => r.content).join('\n\n');
  const lastByRole = {};
  for (const row of assistantRows) lastByRole[row.agent_slug ?? 'unknown'] = row.content;
  const finalText = Object.values(lastByRole).join('\n\n');

  return {
    role: caseDef.role,
    files,
    originalFiles,
    toolCalls,
    toolCallsByRole,
    grantedToolsByRole,
    comments,
    references,
    bibText,
    projectConfig,
    jobs,
    finalText,
    allText,
    fileChanges: drive.events.filter((e) => e.type === 'file_change'),
    fixturePmids: Object.keys(caseFixture.literature?.pmids ?? {}),
    groundText: (caseDef.ground ?? []).map((k) => corpus.files[k] ?? '').join('\n'),
    qaTranscript: drive.qa,
    terminal: drive.terminal,
  };
}

/**
 * Run one root task to completion, answering ask_user questions from the
 * case's canned replies (recorded in the Q&A transcript).
 */
async function driveCase(caseDef, fixture) {
  const ac = new AbortController();
  const appTask = {
    role: caseDef.role,
    projectId: fixture.projectId,
    input: caseDef.prompt,
    context: caseDef.context ?? null,
    sessionId: null,
    compose: false,
    seeding: false,
    userId: fixture.userId,
    detachable: false,
    signal: ac.signal,
  };
  const internal = { budget: undefined, depth: 0, parentJobId: null };
  const gen = runAgentTask(appTask, internal);

  const events = [];
  const qa = [];
  const used = new Set();
  let terminal = 'none';
  for await (const event of gen) {
    events.push(event);
    if (event.type === 'question') {
      const content = String(event.content ?? '');
      let reply = caseDef.defaultReply;
      const ix = (caseDef.replies ?? []).findIndex((r, i) => !used.has(i) && (r.match == null || content.includes(r.match)));
      if (ix >= 0) {
        used.add(ix);
        reply = caseDef.replies[ix].reply;
      }
      qa.push({ q: content, a: reply });
      if (event.jobId != null) await deliverReply(event.jobId, reply);
    } else if (event.type === 'done') {
      terminal = 'done';
    } else if (event.type === 'error') {
      terminal = 'error';
    }
  }
  return { events, qa, terminal };
}

/** True when the Docker daemon AND the R sandbox image are available. */
export function dockerSandboxAvailable(rscriptImage) {
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    return false;
  }
  if (!rscriptImage) return false;
  try {
    execSync(`docker image inspect ${JSON.stringify(rscriptImage)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one case: purge the throwaway DB, seed the fixture, drive the real
 * model, observe, and run the objective checks.
 *
 * @returns {object} the result entry (result.js shape) + the raw observation
 *   under `extra.observation` for the blinded sheet.
 */
export async function runCase(caseDef, { corpus, rscriptImage = null, sandboxEnabled = false }) {
  const started = Date.now();

  if (caseDef.requiresSandbox && !sandboxEnabled) {
    return {
      id: caseDef.id,
      ok: true,
      status: 'skipped',
      violations: [],
      objective: {
        invariants: [],
        checks: [],
        reason: 'sandbox-dependent case not opt-in enabled (pass --sandbox)',
      },
      usage: null,
      latencyMs: Date.now() - started,
      rubric: null,
      extra: { observation: null, skipped: true },
    };
  }

  if (caseDef.requiresSandbox && !dockerSandboxAvailable(rscriptImage)) {
    return {
      id: caseDef.id,
      ok: true,
      status: 'skipped',
      violations: [],
      objective: {
        invariants: [],
        checks: [],
        reason: `docker sandbox unavailable (needs ${rscriptImage ?? 'the R image'}) — case requires real sandbox execution`,
      },
      usage: null,
      latencyMs: Date.now() - started,
      rubric: null,
      extra: { observation: null, skipped: true },
    };
  }

  await resetDatabase();
  const fixtureSpec = composeCaseFixture(corpus, caseDef.fixture);
  const fixture = await seedFixture(fixtureSpec);
  const network = installEvalNetwork(fixtureSpec.literature);

  let obs;
  try {
    const drive = await driveCase(caseDef, fixture);
    // Let queued microtasks (channel drains, question registry) settle.
    await new Promise((r) => setTimeout(r, 25));
    obs = await buildObservation(caseDef, corpus, fixture, fixtureSpec, drive);
  } finally {
    network.restore();
  }

  const results = runChecks(caseDef, obs);
  // Terminal invariant: a quality case is a normal completion.
  if (obs.terminal !== 'done') {
    results.unshift({
      id: 'run-terminated',
      name: 'run completed with a done terminal',
      invariant: true,
      pass: false,
      detail: `terminal was '${obs.terminal}' (jobs: ${obs.jobs.map((j) => `${j.role}:${j.status}`).join(', ') || 'none'})`,
    });
  }

  const invariantResults = results.filter((r) => r.invariant);
  const checkResults = results.filter((r) => !r.invariant);
  const invariantFailures = invariantResults.filter((r) => !r.pass);
  const ok = invariantFailures.length === 0;
  const usage = {
    inputTokens: obs.jobs.reduce((s, j) => s + (j.input_tokens ?? 0), 0),
    outputTokens: obs.jobs.reduce((s, j) => s + (j.output_tokens ?? 0), 0),
  };

  return {
    id: caseDef.id,
    ok,
    status: ok ? 'passed' : 'failed',
    violations: invariantFailures.map((r) => `${r.name}: ${r.detail}`),
    objective: {
      invariants: invariantResults.map((r) => ({ name: r.name, pass: r.pass, detail: r.detail })),
      checks: checkResults.map((r) => ({ name: r.name, pass: r.pass, detail: r.detail })),
    },
    usage: usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : null,
    latencyMs: Date.now() - started,
    rubric: null,
    extra: {
      observation: {
        ...obs,
        networkPassthroughs: network.passthroughs,
      },
    },
  };
}

/**
 * Run the baseline suite.
 * @param {object} p
 * @param {Array<object>} p.cases - the case definitions to run
 * @param {object} p.corpus - loadCorpus()
 * @param {object} [p.modelOverrides] - { [agentSlug]: modelId } applied to the
 *   agents table before each case (recorded in the result config)
 * @param {string} [p.rscriptImage] - sandbox R image (from config)
 * @returns {Promise<Array<object>>} one result entry per case
 */
export async function runBaselineSuite({ cases, corpus, modelOverrides = {}, rscriptImage = null, sandboxEnabled = false }) {
  const entries = [];
  for (const caseDef of cases) {
    if (Object.keys(modelOverrides).length > 0) {
      for (const [slug, model] of Object.entries(modelOverrides)) {
        dbQuery('UPDATE agents SET model = $1 WHERE slug = $2', [model, slug]);
      }
    }
    const entry = await runCase(caseDef, { corpus, rscriptImage, sandboxEnabled });
    entries.push(entry);
    // Keep the run dir clean between cases (fresh temp project roots each time).
    process.stdout.write(`[baseline] ${caseDef.id}: ${entry.status}` +
      (entry.ok ? '' : ` (${entry.violations.length} invariant failure(s))`) + '\n');
  }
  return entries;
}
