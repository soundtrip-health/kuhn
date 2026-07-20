// Story 015: deterministic project seeding pipeline. The flow from
// use-case.md Phase 1 — research → skeleton — is code dispatching agent
// tasks (epic key decision), not agent-driven control flow. Intake is
// handled by the setup wizard before this pipeline ever runs. Each stage
// is a separate top-level runAgentTask, so each gets its own weighted token
// budget (story 020) instead of sharing one dispatch-tree budget.

import { getProject } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';
import { EventChannel } from './events.js';
import { runAgentTask } from './runtime.js';

/**
 * Run the seeding pipeline for a project. Yields the stages' agent events
 * interleaved with stage markers:
 *   { type: 'stage', stage: 'research'|'skeleton'|'seeding',
 *     status: 'start'|'done'|'error', detail? }
 *
 * Failure policy: a project without a saved config (title + research
 * question — set by the setup wizard) aborts the pipeline before any agent
 * is dispatched; a failed research branch is reported but does not block
 * the skeleton; a skeleton failure ends the pipeline as an error.
 * pm/status.md records the per-stage outcomes either way.
 *
 * @param {number|string} projectId
 * @param {object} [opts]
 * @param {Function} [opts.runTask] - runAgentTask, injectable for tests
 * @param {number|null} [opts.userId] - Who triggered the seed (story 007-001);
 *   stamped on every stage's job/conversation/messages
 */
export async function* runSeedPipeline(projectId, { runTask = runAgentTask, userId = null } = {}) {
  const outcomes = {}; // stage/agent → 'ok' | error message

  const project = await getProject(projectId);
  const config = project?.config ?? {};
  // Intake now comes from the setup wizard; guard an unconfigured project so the
  // research/skeleton stages never run on an empty config.
  if (!config.title || !config.research_question) {
    yield {
      type: 'stage',
      stage: 'seeding',
      status: 'error',
      detail: 'project is not configured yet — complete project setup first',
    };
    return;
  }

  // --- Stage 1: RA + Advisor research in parallel ----------------------------
  yield { type: 'stage', stage: 'research', status: 'start' };
  // seeding: true bypasses suggestion mode (story 008-001) — the pipeline
  // writes the first draft directly; there is nothing to protect yet.
  const branchErrors = yield* forwardParallel([
    runTask({ role: 'ra', projectId, input: raInput(config), context: { seedStage: 'research' }, userId, seeding: true }),
    runTask({ role: 'advisor', projectId, input: advisorInput(config), context: { seedStage: 'research' }, userId, seeding: true }),
  ]);
  outcomes.ra = branchErrors[0] ?? 'ok';
  outcomes.advisor = branchErrors[1] ?? 'ok';
  const failed = branchErrors.filter(Boolean);
  yield {
    type: 'stage',
    stage: 'research',
    status: 'done',
    ...(failed.length > 0 ? { detail: `${failed.length} of 2 research tasks failed` } : {}),
  };

  // --- Stage 2: Writer skeleton ----------------------------------------------
  yield { type: 'stage', stage: 'skeleton', status: 'start' };
  const skeletonError = yield* forwardTask(
    runTask({ role: 'writer', projectId, input: writerInput(config), context: { seedStage: 'skeleton' }, userId, seeding: true }),
  );
  outcomes.skeleton = skeletonError ?? 'ok';
  yield { type: 'stage', stage: 'skeleton', status: skeletonError ? 'error' : 'done', ...(skeletonError ? { detail: skeletonError } : {}) };

  // --- Status file (deterministic, written by the pipeline) ------------------
  await writeStatusFile(projectId, config, outcomes);
  yield { type: 'file_change', agent: 'pm', path: 'pm/status.md', kind: 'create' };
  yield {
    type: 'stage',
    stage: 'seeding',
    status: skeletonError ? 'error' : 'done',
    ...(skeletonError ? { detail: 'skeleton generation failed' } : {}),
  };
}

/**
 * Forward one task's events to the consumer; returns the first error message
 * (or null). `yield*` propagates early consumer termination into the task
 * generator, which cancels the underlying SDK loop.
 */
async function* forwardTask(events) {
  let error = null;
  for await (const event of events) {
    error ??= event.type === 'error' ? (event.message ?? 'agent task failed') : null;
    yield event;
  }
  return error;
}

/**
 * Run tasks concurrently, forwarding their interleaved events; returns the
 * per-task first error messages (null where the task succeeded).
 */
async function* forwardParallel(tasks) {
  const channel = new EventChannel();
  const errors = tasks.map(() => null);
  let active = tasks.length;

  const pumps = tasks.map(async (task, i) => {
    try {
      for await (const event of task) {
        if (event.type === 'error') errors[i] ??= event.message ?? 'agent task failed';
        channel.push(event);
      }
    } catch (err) {
      errors[i] ??= err.message;
    } finally {
      if (--active === 0) channel.end();
    }
  });

  try {
    for await (const event of channel) yield event;
  } finally {
    // Consumer stopped early — stop the in-flight tasks and drain the pumps
    channel.end();
    await Promise.all(tasks.map((t) => t.return?.().catch(() => {})));
    await Promise.all(pumps);
  }
  return errors;
}

async function writeStatusFile(projectId, config, outcomes) {
  const line = (label, value) => (value ? `- ${label}: ${value}` : null);
  const content = [
    `# Project status — ${config.title ?? 'unconfigured project'}`,
    '',
    `Seeded ${new Date().toISOString().slice(0, 10)} by the Kuhn seeding pipeline.`,
    '',
    '## Configuration',
    '',
    line('Type', config.project_type),
    line('Research question', config.research_question),
    line('Timeline', config.timeline),
    line('Deliverables', config.deliverables?.join('; ')),
    '',
    '## Seeding stages',
    '',
    ...Object.entries(outcomes).map(([stage, outcome]) =>
      `- ${stage}: ${outcome === 'ok' ? 'ok' : `FAILED — ${outcome}`}`),
    '',
    '## Where things live',
    '',
    '- `project.json` — structured project configuration',
    '- `draft/main.md` — skeleton draft (Writer owns this file)',
    '- `draft/references.bib` — bibliography (RA owns this file)',
    '- `research/literature-summary.md` — annotated literature overview',
    '- `guidance/` — domain guidance summaries and `index.md`',
    '',
  ].filter((l) => l !== null).join('\n');

  try {
    await writeProjectFile(projectId, 'pm/status.md', content);
  } catch (err) {
    console.error('[seeding] Failed to write pm/status.md:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Stage instructions — self-contained: everything the agent needs is in the
// prompt or readable from the workspace; none of them may ask the user.
// ---------------------------------------------------------------------------

const describeProject = (config) => [
  `Project: ${config.title} (${config.project_type})`,
  `Research question: ${config.research_question}`,
  config.deliverables?.length ? `Deliverables: ${config.deliverables.join('; ')}` : null,
  config.source_materials?.length ? `Source materials on hand: ${config.source_materials.join('; ')}` : null,
  config.notes ? `Notes: ${config.notes}` : null,
].filter(Boolean).join('\n');

function raInput(config) {
  return [
    'A new project was just configured; produce its initial bibliography. This task is',
    'self-contained — work from the description below and do not ask the user anything.',
    '',
    describeProject(config),
    '',
    'Steps:',
    '1. Search the literature (pubmed_search, arxiv_search, web_search) for the most',
    '   relevant and load-bearing work for this project — aim for the 10–20 best papers,',
    '   not an exhaustive sweep.',
    '2. Add each to the project bibliography: use add_citation with the PMID for PubMed',
    '   results, and add_reference (with source_type) for preprints or other web sources.',
    '   These store the reference and keep draft/references.bib in sync — never write the',
    '   .bib file by hand. Never fabricate entries: only papers your searches returned.',
    '3. Write research/literature-summary.md: a short annotated overview grouping the',
    '   papers by theme, with one or two sentences on why each matters to this project,',
    '   citing each as [@key] using the keys the tools return.',
  ].join('\n');
}

function advisorInput(config) {
  return [
    'A new project was just configured; lay the domain-guidance groundwork. This task is',
    'self-contained — work from the description below and do not ask the user anything.',
    '',
    describeProject(config),
    '',
    'Steps:',
    '1. List guidance/ and seed_docs/ in the workspace. If the user uploaded source or',
    '   guidance documents (the PM organizes uploads into seed_docs/), read each and write',
    '   a structured summary under guidance/ (guidance/<name>-summary.md).',
    '2. Write guidance/index.md: the key regulatory and domain considerations for this',
    '   project type, the frameworks that apply, and — using web_search where helpful —',
    '   the authoritative guidance documents worth obtaining, each with a one-line "why".',
  ].join('\n');
}

function writerInput(config) {
  return [
    'A new project was just seeded; generate the skeleton draft. This task is',
    'self-contained — work from the description below and do not ask the user anything,',
    'and do not dispatch sub-agents.',
    '',
    describeProject(config),
    '',
    'Steps:',
    '1. Read project.json, draft/references.bib (if present), research/literature-summary.md',
    '   (if present), and guidance/index.md (if present).',
    '2. Write draft/main.md: a complete section skeleton appropriate for the project type,',
    '   with a title, one or two sentences per section stating its intent, TODO markers',
    '   for the substantive work to come, and initial citations where the seeded',
    '   bibliography supports them. Cite as [@key] using only keys that actually appear',
    '   in draft/references.bib — never invent citation keys.',
  ].join('\n');
}
