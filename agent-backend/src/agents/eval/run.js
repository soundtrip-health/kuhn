#!/usr/bin/env node
/**
 * Quality-baseline capture — explicit opt-in (STH-31).
 *
 * This is the ONLY path in the repo that spends model quota on the baseline
 * suite. Ordinary tests (vitest) never import the execution path.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npm run eval:baseline -- [options]
 *
 * Options:
 *   --case <id>          run only the named case (repeatable)
 *   --dry-run            validate the corpus + cases and print the plan;
 *                        makes no model calls and needs no credentials
 *   --out <dir>          results directory (default: agent-backend/eval-results)
 *   --runtime <label>    runtime label recorded in the result (default: claude-sdk)
 *   --model <spec>       model override: 'writer=claude-opus-4-8,ra=...' or a
 *                        single model id applied to all six agents
 *   --sandbox            also run Docker-dependent cases (analyst-data-summary)
 *   --repeat <n>         repeat each case n times (default: 1)
 *   --score <file.json>  merge rubric scores into an existing record:
 *                        { "<caseId>": { "prose-quality": 3, ... } }
 *
 * Deliverable label (for this PR): conformance harness + pre-migration
 * quality-baseline infrastructure. The captured record is the pre-migration
 * Claude baseline; the post-migration Pi run is produced by the same command
 * once the Pi runtime is registered with runAgentTask (run.js --runtime pi).
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from './corpus.js';
import { CASES, validateCases } from './cases.js';
import { validateCheckSpecs } from './checks.js';
import { makeSalt, blindCaseId, renderBlindedSheet, mergeScores } from './rubric.js';

const AGENT_SLUGS = ['pm', 'writer', 'ra', 'advisor', 'reviewer', 'analyst'];

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 30).join('\n').replace(/^ \* ?/gm, ''));
}

function parseArgs(argv) {
  const flags = {
    cases: null,
    dryRun: false,
    out: null,
    runtime: 'claude-sdk',
    model: null,
    sandbox: false,
    repeat: 1,
    score: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--case') flags.cases = [...(flags.cases ?? []), argv[++i]];
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--runtime') flags.runtime = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--sandbox') flags.sandbox = true;
    else if (a === '--repeat') flags.repeat = Number(argv[++i]);
    else if (a === '--score') flags.score = argv[++i];
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else {
      console.error(`unknown option: ${a}`);
      usage();
      process.exit(2);
    }
  }
  if (!Number.isInteger(flags.repeat) || flags.repeat < 1) {
    console.error('--repeat must be a positive integer');
    process.exit(2);
  }
  return flags;
}

/** Parse --model into { [agentSlug]: modelId }. */
function parseModelSpec(spec) {
  const overrides = {};
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const slug = part.slice(0, eq).trim();
      const model = part.slice(eq + 1).trim();
      if (!AGENT_SLUGS.includes(slug)) throw new Error(`unknown agent slug '${slug}' (expected: ${AGENT_SLUGS.join(', ')})`);
      overrides[slug] = model;
    } else {
      for (const slug of AGENT_SLUGS) overrides[slug] = part;
    }
  }
  if (Object.keys(overrides).length === 0) throw new Error('empty --model spec');
  return overrides;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  // ---- Static half: corpus + case validation (no Kuhn imports) ------------
  const corpus = loadCorpus();
  const caseProblems = validateCases(CASES);
  for (const c of CASES) caseProblems.push(...validateCheckSpecs(c));
  if (caseProblems.length > 0) {
    console.error('corpus/case validation failed:');
    for (const p of caseProblems) console.error(`  - ${p}`);
    process.exit(2);
  }

  let selected = CASES;
  if (flags.cases?.length) {
    selected = CASES.filter((c) => flags.cases.includes(c.id));
    const missing = flags.cases.filter((id) => !selected.some((c) => c.id === id));
    if (missing.length > 0) {
      console.error(`unknown case id(s): ${missing.join(', ')} (known: ${CASES.map((c) => c.id).join(', ')})`);
      process.exit(2);
    }
  }

  // ---- Score merging (no model, no env setup) ------------------------------
  if (flags.score) {
    const [recordPath, scoresPath] = flags.score.includes(',')
      ? flags.score.split(',')
      : [flags.score, flags.score.replace(/\.json$/, '.scores.json')];
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    const scores = JSON.parse(readFileSync(scoresPath, 'utf-8'));
    const problems = mergeScores(record, scores);
    if (problems.length > 0) {
      console.error('score merge failed:');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(2);
    }
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    console.log(`[baseline] scores merged into ${recordPath}`);
    return;
  }

  // ---- Dry run: plan only ---------------------------------------------------
  if (flags.dryRun) {
    console.log(`[baseline] dry run — no model calls, no credentials needed`);
    console.log(`[baseline] corpus: ${corpus.manifest.name} v${corpus.version} hash=${corpus.hash.slice(0, 16)}…`);
    for (const c of selected) {
      const inv = c.checks.filter((k) => k.invariant).length;
      const extra = c.requiresSandbox ? ' [needs --sandbox + docker]' : '';
      console.log(`[baseline]   ${c.id} (${c.role}): ${c.checks.length} checks, ${inv} invariant${c.checks.length === 1 ? '' : 's'}${extra} — ${c.title}`);
    }
    console.log('[baseline] to capture the baseline: ANTHROPIC_API_KEY=... npm run eval:baseline');
    return;
  }

  // ---- Execution path: needs credentials; Kuhn modules load AFTER env setup -
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — the baseline runner spends real model quota and refuses to run without credentials.');
    console.error('');
    console.error('To capture the pre-migration Claude baseline:');
    console.error('');
    console.error('  cd agent-backend');
    console.error('  ANTHROPIC_API_KEY=sk-ant-... npm run eval:baseline');
    console.error('');
    console.error('Outputs:');
    console.error('  eval-results/<run-id>.json             reproducible result record (git SHA, runtime, models,');
    console.error('                                         corpus version + hash, objective results, usage, latency)');
    console.error('  eval-results/<run-id>/blinded-sheet.md blinded human rubric sheet (score 0–4, then');
    console.error('                                         npm run eval:baseline -- --score <record.json>,<scores.json>)');
    process.exit(2);
  }

  const modelOverrides = flags.model ? parseModelSpec(flags.model) : {};

  // Unique temp data dir (KUHN_DATA_DIR) — the runner never touches another
  // contributor's data. Catalog roots point at empty temp dirs so the seed
  // no-ops the guidance/script catalogs (deterministic org knowledge = the
  // corpus org documents only).
  const dataDir = mkdtempSync(join(tmpdir(), 'kuhn-eval-'));
  const guidanceCatalog = join(dataDir, 'catalogs', 'guidance');
  const scriptsCatalog = join(dataDir, 'catalogs', 'scripts');
  mkdirSync(guidanceCatalog, { recursive: true });
  mkdirSync(scriptsCatalog, { recursive: true });
  process.env.KUHN_DATA_DIR = dataDir;
  process.env.KUHN_GUIDANCE_DOCS = guidanceCatalog;
  process.env.KUHN_SHARED_SCRIPTS = scriptsCatalog;

  const { runBaselineSuite } = await import('./runner.js');
  const { config } = await import('../../config.js');
  const { querySync } = await import('../../db.js');
  const { createResultRecord, gitSha } = await import('../conformance/result.js');

  const rscriptImage = config.sandbox?.rscriptImage ?? null;

  // Expand repeats (entries keep unique ids: caseId for repeat 1, caseId~rN after).
  const queue = [];
  for (const caseDef of selected) {
    for (let r = 1; r <= flags.repeat; r += 1) {
      queue.push(r === 1 ? caseDef : { ...caseDef, id: `${caseDef.id}~r${r}` });
    }
  }

  const entries = await runBaselineSuite({
    cases: queue,
    corpus,
    modelOverrides,
    rscriptImage,
    sandboxEnabled: flags.sandbox,
  });

  // Record the effective per-role models (after overrides).
  const modelsByRole = {};
  for (const slug of AGENT_SLUGS) {
    const row = querySync('SELECT model FROM agents WHERE slug = $1', [slug]).rows[0];
    modelsByRole[slug] = row?.model ?? null;
  }

  const salt = makeSalt();
  const passthroughs = entries.flatMap((e) => e.extra?.observation?.networkPassthroughs ?? []);
  const record = createResultRecord({
    suite: 'quality-baseline',
    runtime: flags.runtime,
    provider: 'anthropic',
    model: modelsByRole,
    fixtures: { version: corpus.version, hash: corpus.hash, name: corpus.manifest.name },
    config: {
      tokenBudget: config.agent.tokenBudget,
      budgetGrace: config.agent.budgetGrace,
      maxDispatchDepth: config.agent.maxDispatchDepth,
      questionTimeoutMs: config.agent.questionTimeoutMs,
      retry: config.agent.retry,
      modelWeights: config.agent.modelWeights,
      models: modelsByRole,
      sandbox: flags.sandbox ? 'enabled' : 'disabled',
      network: 'fixture-intercepted',
    },
    entries,
    extra: {
      label: 'conformance harness + pre-migration quality baseline infrastructure (STH-5/STH-31)',
      corpusVersion: corpus.version,
      blinded: { salt, mapping: Object.fromEntries(selected.map((c) => [blindCaseId(c.id, salt), c.id])) },
      unmockedNetwork: passthroughs,
      dataDir,
    },
  });

  const outDir = flags.out ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval-results');
  mkdirSync(outDir, { recursive: true });
  const runId = `${stamp()}-${(gitSha() ?? 'nogit').slice(0, 7)}-${flags.runtime}`;
  const recordPath = join(outDir, `${runId}.json`);
  const sheetPath = join(outDir, `${runId}`, 'blinded-sheet.md');
  mkdirSync(dirname(sheetPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  writeFileSync(sheetPath, renderBlindedSheet(selected, entries, salt));

  const failed = entries.filter((e) => !e.ok);
  const skipped = entries.filter((e) => e.status === 'skipped');
  console.log('');
  console.log(`[baseline] run complete: ${entries.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const e of failed) {
    console.log(`[baseline]   FAIL ${e.id}:`);
    for (const v of e.violations) console.log(`[baseline]     - ${v}`);
  }
  console.log('');
  console.log(`[baseline] record:  ${recordPath}`);
  console.log(`[baseline] sheet:   ${sheetPath}`);
  if (passthroughs.length > 0) {
    console.log(`[baseline] WARNING: ${passthroughs.length} unmocked network call(s) — see unmockedNetwork in the record`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[baseline] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
