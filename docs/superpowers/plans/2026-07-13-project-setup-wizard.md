# Project Setup Wizard + Calmer PM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the token-spending PM intake interview with a deterministic, token-free project setup wizard; remove the `ask_user` countdown/auto-default so a question waits indefinitely; and recast the PM as gentle and clarifying-only.

**Architecture:** Three lanes. (1) A client-side **wizard** (`webapp/src/wizard.ts`) collects all structured intake + seed uploads and writes config via a new `PUT /api/projects/:id/config` endpoint — no model calls. (2) The **seeding pipeline** (`agent-backend/src/agents/seeding.js`) drops its PM-interview stage and runs research→skeleton from the wizard-saved config, launched only on explicit confirmation. (3) **PM chat** is reserved for clarifying questions and gentle nudging.

**Tech Stack:** Backend — Node ESM, Express, better-sqlite3 (via `db.js` shim), vitest (colocated `*.test.js`). Webapp — Vite + dependency-light TypeScript, no framework; verified via `tsc`/`npm run build` and token-free check scripts.

## Global Constraints

- **Project types** are exactly `['rwe-protocol','rct-protocol','grant','manuscript','sop']` — copy verbatim; keep webapp `project-types.ts` and backend route/schema in sync.
- **All project file access goes through `storage.js`** (`writeProjectFile`, `uploadFiles`) — never touch project paths directly.
- **Both apps are plain ESM / dependency-light TS** — match surrounding code; keep modules small and single-purpose.
- **Tests are colocated `*.test.js`, run with vitest** in `agent-backend/`.
- **Config field names:** canonical stored config uses snake_case (`project_type`, `research_question`, `source_materials`); the wizard "answers" object and its wire/`config.setup.answers` form use camelCase (`projectType`, `researchQuestion`, `sourceMaterials`). The endpoint translates camelCase answers → snake_case canonical.
- **`project.json`** contains ONLY the canonical config subset (title, project_type, research_question, deliverables, timeline, source_materials, notes?) — never the `setup` draft.
- Commit after every task. End commit messages with the Co-Authored-By trailer already used on this branch.

---

## File Structure

**New**
- `agent-backend/src/agents/project-config.js` — shared `applyProjectConfig` (DB config merge + `project.json` write). Used by the `save_project_config` agent tool and the new REST endpoint.
- `agent-backend/src/agents/project-config.test.js` — unit test for the helper.
- `webapp/src/wizard.ts` — the setup wizard modal (state, steps, guidance disclosures, persistence, launch).

**Modified — backend**
- `src/config.js` — `questionTimeoutMs` defaults to `null` (no timeout).
- `src/agents/questions.js` — `waitForReply` skips the timer when `timeoutMs` is null/0.
- `src/agents/questions.test.js` — add no-timeout test.
- `src/agents/runtime.js` — `save_project_config` delegates to `applyProjectConfig`.
- `src/routes/projects.js` — add `PUT /api/projects/:id/config`.
- `src/routes/projects.test.js` — cover the new endpoint.
- `src/agents/seeding.js` — remove interview stage + `INTERVIEW_INPUT`; add unconfigured guard.
- `src/agents/seeding.test.js` — update stage expectations.
- `src/db/prompts/pm.md` — remove interview/pressure; gentle nudging.

**Modified — webapp**
- `src/api.ts` — `saveProjectConfig`, `WizardAnswers`, extended `Project.config` type.
- `src/workspace.ts` — `applyProjectUpdate`.
- `src/seeding.ts` — drop the `interview` stage.
- `src/question-card.ts` — remove countdown/depletion/defaults copy.
- `src/chat.ts` — greeting CTA points at the wizard via an injected handler.
- `src/main.ts` — auto-open the wizard once; wire the greeting handler.
- `src/project-browser.ts` — per-card "Set up / Resume setup" action.
- `src/style.css` — wizard styles.

---

## Task 1: Remove the ask_user countdown (backend)

**Files:**
- Modify: `agent-backend/src/config.js:48-50`
- Modify: `agent-backend/src/agents/questions.js:18-28`
- Test: `agent-backend/src/agents/questions.test.js`

**Interfaces:**
- Produces: `waitForReply(jobId, timeoutMs, meta?)` where `timeoutMs === null` (or `0`) means "wait indefinitely — no auto-resolve". `config.agent.questionTimeoutMs` is now `number | null` (null by default).

- [ ] **Step 1: Write the failing test**

Add to `agent-backend/src/agents/questions.test.js` inside `describe('question registry', …)`:

```js
  it('waits indefinitely when timeoutMs is null (no auto-resolve)', async () => {
    const wait = waitForReply(6, null);
    expect(hasPendingQuestion(6)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // a tick passes…
    expect(hasPendingQuestion(6)).toBe(true);    // …still parked
    deliverReply(6, 'eventually');
    await expect(wait).resolves.toBe('eventually');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-backend && npx vitest run src/agents/questions.test.js`
Expected: FAIL — with the current code `setTimeout(fn, null)` fires ~immediately, so the waiter resolves `null` and `hasPendingQuestion(6)` is already false (or the reply returns null).

- [ ] **Step 3: Implement — skip the timer when there is no timeout**

In `agent-backend/src/agents/questions.js`, replace the body of `waitForReply`:

```js
export function waitForReply(jobId, timeoutMs, meta = {}) {
  cancelQuestion(jobId); // a job asks one question at a time
  return new Promise((resolve) => {
    // timeoutMs null/0 → wait indefinitely: the PI may step away mid-question,
    // and the job just waits until they reply (or the task is torn down).
    let timer = null;
    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        pending.delete(jobId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    }
    pending.set(jobId, { resolve, timer, question: meta.question, agent: meta.agent });
  });
}
```

(`deliverReply`/`cancelQuestion` already call `clearTimeout(waiter.timer)`; `clearTimeout(null)` is a safe no-op — no change needed there.)

- [ ] **Step 4: Default the config to no-timeout**

In `agent-backend/src/config.js`, replace lines 48-50:

```js
    // How long ask_user waits for a reply before proceeding. Default null =
    // wait indefinitely (if the PI steps away, the question just waits). Set
    // AGENT_QUESTION_TIMEOUT_MS to a number to re-enable an auto-default.
    questionTimeoutMs: process.env.AGENT_QUESTION_TIMEOUT_MS
      ? parseInt(process.env.AGENT_QUESTION_TIMEOUT_MS)
      : null,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent-backend && npx vitest run src/agents/questions.test.js`
Expected: PASS (all cases, including the existing timeout/cancel tests which pass an explicit `timeoutMs`).

- [ ] **Step 6: Commit**

```bash
git add agent-backend/src/config.js agent-backend/src/agents/questions.js agent-backend/src/agents/questions.test.js
git commit -m "ask_user waits indefinitely by default (no countdown/auto-default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove the countdown from the question card (webapp)

**Files:**
- Modify: `webapp/src/question-card.ts`

**Interfaces:**
- Produces: `QuestionCard` with the same public methods (`markAnswered`, `markExpired`, `destroy`) but no timer/countdown; `markExpired` now means "torn down / no longer active", not "timed out with defaults".

- [ ] **Step 1: Rewrite the card without the timer**

Replace the whole of `webapp/src/question-card.ts` with:

```ts
// Agent question card (story 025; countdown removed): the pending → answered |
// closed states for an ask_user decision. The real ask_user flow takes a
// free-text answer typed into the chat input, so the card is the visual
// surface: it shows the question; the actual answer is driven by chat.ts
// (markAnswered) and, only on task teardown, the `question_expired` event
// (markClosed). There is no countdown — a question waits until answered.

import { agentIdentity } from './agents';
import { icon } from './icons';

export class QuestionCard {
  readonly element: HTMLElement;
  private settled = false;
  private readonly agentLabel: string;
  private readonly questionText: string;

  constructor(agentSlug: string, questionText: string) {
    this.questionText = questionText;
    this.agentLabel = agentIdentity(agentSlug).label || 'Agent';
    this.element = document.createElement('div');
    this.element.className = 'question-card is-pending';
    this.renderPending();
  }

  private renderPending(): void {
    this.element.innerHTML =
      `<div class="qc-inner">` +
        `<div class="qc-head">` +
          `<div class="qc-title"><span class="dot"></span>${escape(this.agentLabel)} needs a decision</div>` +
        `</div>` +
        `<div class="qc-question">${escape(this.questionText)}</div>` +
        `<div class="qc-foot">Type your answer in the chat box below — take your time.</div>` +
      `</div>`;
  }

  /** Flip to the calm confirmation state after the user answers. */
  markAnswered(answerText: string): void {
    if (this.settled) return;
    this.settled = true;
    this.element.className = 'question-card is-answered';
    const check = icon('check', { size: 11, stroke: 3 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-check">${check}</span>` +
        `Decision recorded · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">${escape(this.questionText)}</div>` +
      `<div class="qc-chose">You answered: ${escape(truncate(answerText, 60))}</div>`;
  }

  /** Flip to the neutral closed state when the task ends without an answer. */
  markExpired(): void {
    if (this.settled) return;
    this.settled = true;
    this.element.className = 'question-card is-expired';
    const clock = icon('clock', { size: 14, stroke: 2 });
    this.element.innerHTML =
      `<div class="qc-resolved-head"><span class="qc-expired-clock">${clock}</span>` +
        `No longer active · ${escape(this.agentLabel)}</div>` +
      `<div class="qc-resolved-body">This question is no longer active. ` +
        `You can pick it back up in the chat anytime.</div>`;
  }

  destroy(): void {
    this.settled = true;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
```

- [ ] **Step 2: Remove the now-dead depletion CSS**

Run: `cd webapp && grep -n "qc-deplete\|qc-countdown\|qc-time" src/style.css`
Delete the `.qc-deplete`, `.qc-deplete-fill`, `.qc-countdown`, and `.qc-time` rules (and any `@keyframes` used only by the depletion bar). Leave `.qc-inner/.qc-head/.qc-title/.qc-question/.qc-foot/.qc-resolved-*` intact.

- [ ] **Step 3: Verify the build type-checks**

Run: `cd webapp && npm run build`
Expected: PASS (no references to `markExpired`'s old semantics elsewhere; `chat.ts` still calls `markExpired()` on teardown, which is fine).

- [ ] **Step 4: Commit**

```bash
git add webapp/src/question-card.ts webapp/src/style.css
git commit -m "Remove ask_user countdown from the question card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Shared applyProjectConfig helper + runtime refactor

**Files:**
- Create: `agent-backend/src/agents/project-config.js`
- Create: `agent-backend/src/agents/project-config.test.js`
- Modify: `agent-backend/src/agents/runtime.js:791-819` (the `save_project_config` handler body)

**Interfaces:**
- Produces: `applyProjectConfig(projectId, canonicalConfig, opts?) -> Promise<{ project, created }>`
  - `canonicalConfig`: `{ title, project_type, research_question, deliverables, timeline, source_materials, notes? }`
  - `opts.extraConfig` (default `{}`): merged into the DB `config` blob but **excluded** from `project.json` (e.g. `{ setup: {...} }`).
  - Merges canonical (+extra) into `projects.config`, sets `project_type`, writes `project.json` from `canonicalConfig` only. Returns the updated project row and whether `project.json` was newly created.
- Consumes (Task 4, runtime): `updateProjectConfig` (existing), `writeProjectFile` (existing).

- [ ] **Step 1: Write the failing test**

Create `agent-backend/src/agents/project-config.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/projects.js', () => ({ updateProjectConfig: vi.fn() }));
vi.mock('../storage.js', () => ({ writeProjectFile: vi.fn(async () => ({ created: true })) }));

import { updateProjectConfig } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';
import { applyProjectConfig } from './project-config.js';

const CANONICAL = {
  title: 'GLP-1 RWE Study',
  project_type: 'rwe-protocol',
  research_question: 'Does GLP-1 use reduce MACE in T2D?',
  deliverables: ['FDA RWE protocol'],
  timeline: 'Draft by 2026-08-01',
  source_materials: ['seed_docs/protocol.pdf'],
};

beforeEach(() => {
  vi.clearAllMocks();
  updateProjectConfig.mockResolvedValue({ id: 1, config: { ...CANONICAL } });
});

describe('applyProjectConfig', () => {
  it('merges the canonical config, sets the type, and writes project.json', async () => {
    const { created } = await applyProjectConfig(1, CANONICAL);
    expect(created).toBe(true);
    expect(updateProjectConfig).toHaveBeenCalledWith(1, {
      projectType: 'rwe-protocol',
      config: CANONICAL,
    });
    expect(writeProjectFile).toHaveBeenCalledWith(
      1, 'project.json', JSON.stringify(CANONICAL, null, 2) + '\n',
    );
  });

  it('merges extraConfig into the DB blob but keeps it out of project.json', async () => {
    await applyProjectConfig(1, CANONICAL, { extraConfig: { setup: { status: 'complete' } } });
    expect(updateProjectConfig).toHaveBeenCalledWith(1, {
      projectType: 'rwe-protocol',
      config: { ...CANONICAL, setup: { status: 'complete' } },
    });
    const written = writeProjectFile.mock.calls[0][2];
    expect(written).not.toContain('setup');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-backend && npx vitest run src/agents/project-config.test.js`
Expected: FAIL — "Failed to resolve import './project-config.js'".

- [ ] **Step 3: Implement the helper**

Create `agent-backend/src/agents/project-config.js`:

```js
// Shared project-config write path (used by the save_project_config agent tool
// and the wizard's PUT /api/projects/:id/config endpoint). Merges the canonical
// config into projects.config, keeps project_type in sync, and writes
// project.json — from the canonical fields only. `extraConfig` (e.g. the wizard
// `setup` draft state) is stored in the DB blob but never written to project.json.

import { updateProjectConfig } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';

/**
 * @param {number|string} projectId
 * @param {object} canonicalConfig - { title, project_type, research_question,
 *   deliverables, timeline, source_materials, notes? }
 * @param {object} [opts]
 * @param {object} [opts.extraConfig] - merged into projects.config, excluded from project.json
 * @returns {Promise<{ project: object|undefined, created: boolean }>}
 */
export async function applyProjectConfig(projectId, canonicalConfig, { extraConfig = {} } = {}) {
  const project = await updateProjectConfig(projectId, {
    projectType: canonicalConfig.project_type,
    config: { ...canonicalConfig, ...extraConfig },
  });
  const { created } = await writeProjectFile(
    projectId,
    'project.json',
    JSON.stringify(canonicalConfig, null, 2) + '\n',
  );
  return { project, created };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-backend && npx vitest run src/agents/project-config.test.js`
Expected: PASS.

- [ ] **Step 5: Refactor the runtime tool to use the helper**

In `agent-backend/src/agents/runtime.js`, replace the `try { … }` body of the `save_project_config` handler (currently lines ~791-819) with:

```js
      async (input) => {
        try {
          const projectConfig = {
            title: input.title,
            project_type: input.project_type,
            research_question: input.research_question,
            deliverables: input.deliverables,
            timeline: input.timeline,
            source_materials: input.source_materials ?? [],
            ...(input.notes ? { notes: input.notes } : {}),
          };
          // Keep the user's chosen project name; the manuscript title lives in
          // config.title (and the user can rename the project explicitly).
          const { created } = await applyProjectConfig(projectId, projectConfig);
          channel.push({
            type: 'file_change',
            agent: agent.slug,
            path: 'project.json',
            kind: created ? 'create' : 'update',
          });
          return { content: [{ type: 'text', text: 'Project configuration saved to the project record and project.json.' }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to save project config: ${err.message}` }], isError: true };
        }
      },
```

Add the import near the other agent imports at the top of `runtime.js`:

```js
import { applyProjectConfig } from './project-config.js';
```

Then check whether `updateProjectConfig` and `writeProjectFile` are still referenced elsewhere in `runtime.js`:

Run: `cd agent-backend && grep -n "updateProjectConfig\|writeProjectFile" src/agents/runtime.js`
If `updateProjectConfig` is no longer used, remove it from the imports; leave `writeProjectFile` if other handlers use it.

- [ ] **Step 6: Run the runtime tests to verify no regression**

Run: `cd agent-backend && npx vitest run src/agents/runtime.test.js`
Expected: PASS. (If a test asserted on `updateProjectConfig` being called directly for `save_project_config`, update it to assert the `file_change` push / `writeProjectFile` behavior instead — the observable output is unchanged.)

- [ ] **Step 7: Commit**

```bash
git add agent-backend/src/agents/project-config.js agent-backend/src/agents/project-config.test.js agent-backend/src/agents/runtime.js
git commit -m "Extract shared applyProjectConfig helper; runtime uses it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: PUT /api/projects/:id/config endpoint

**Files:**
- Modify: `agent-backend/src/routes/projects.js` (add the route + two helpers; import `applyProjectConfig` and `updateProjectConfig`)
- Test: `agent-backend/src/routes/projects.test.js`

**Interfaces:**
- Produces: `PUT /api/projects/:id/config` — body `{ answers, draft? }`.
  - `answers` (camelCase): `{ title, projectType, researchQuestion, deliverables[], timeline, sourceMaterials[], notes? }`.
  - `draft: true` → stores `config.setup = { status: 'draft', answers }` via `updateProjectConfig`; **no** `project.json`, **not** validated for completeness. Returns `{ project }`.
  - final (default) → validates `title`, `projectType` (∈ PROJECT_TYPES), `researchQuestion`; writes canonical config + `project.json` via `applyProjectConfig` with `extraConfig.setup = { status: 'complete', answers }`. Returns `{ project }`. 400 on validation failure.
- Consumes: `authorizeProject` (existing), `applyProjectConfig` (Task 3), `updateProjectConfig` (existing db fn).

- [ ] **Step 1: Write the failing tests**

The existing `projects.test.js` mocks `../db/projects.js` (see its top). Extend that mock and add `../agents/project-config.js`. Add `updateProjectConfig` to the existing `vi.mock('../db/projects.js', …)` factory:

```js
vi.mock('../db/projects.js', () => ({
  getProject: vi.fn(),
  listProjectsForUser: vi.fn(async () => []),
  createProject: vi.fn(),
  setActiveDocument: vi.fn(async () => ({})),
  updateProjectConfig: vi.fn(async (id, fields) => ({ id, ...fields })),
}));
vi.mock('../agents/project-config.js', () => ({
  applyProjectConfig: vi.fn(async (id) => ({ project: { id, config: { setup: { status: 'complete' } } }, created: true })),
}));
```

Add the corresponding imports alongside the existing ones:

```js
import { updateProjectConfig } from '../db/projects.js';
import { applyProjectConfig } from '../agents/project-config.js';
```

Then add a new describe block:

```js
describe('PUT /api/projects/:id/config', () => {
  const answers = {
    title: 'GLP-1 RWE Study',
    projectType: 'rwe-protocol',
    researchQuestion: 'Does GLP-1 use reduce MACE in T2D?',
    deliverables: ['FDA RWE protocol'],
    timeline: 'Draft by 2026-08-01',
    sourceMaterials: [],
  };

  beforeEach(() => getProject.mockResolvedValue({ id: 5, org_id: 7, config: {} }));

  it('saves a draft without writing project.json or validating', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { title: '' }, draft: true }),
    });
    expect(res.status).toBe(200);
    expect(applyProjectConfig).not.toHaveBeenCalled();
    expect(updateProjectConfig).toHaveBeenCalledWith(5, {
      config: { setup: { status: 'draft', answers: expect.objectContaining({ title: '' }) } },
    });
  });

  it('final save writes canonical config + project.json and marks complete', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    expect(res.status).toBe(200);
    expect(applyProjectConfig).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        title: 'GLP-1 RWE Study',
        project_type: 'rwe-protocol',
        research_question: 'Does GLP-1 use reduce MACE in T2D?',
      }),
      { extraConfig: { setup: { status: 'complete', answers: expect.any(Object) } } },
    );
  });

  it('rejects a final save missing required fields', async () => {
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { ...answers, title: '', projectType: 'nope' } }),
    });
    expect(res.status).toBe(400);
    expect(applyProjectConfig).not.toHaveBeenCalled();
  });

  it('404s for a project the user cannot access', async () => {
    isMember.mockResolvedValue(false);
    const res = await fetch(`${base}/api/projects/5/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-backend && npx vitest run src/routes/projects.test.js`
Expected: FAIL — route returns 404 (no such route) / mock not called.

- [ ] **Step 3: Implement the route**

In `agent-backend/src/routes/projects.js`, add the imports:

```js
import { applyProjectConfig } from '../agents/project-config.js';
```

and add `updateProjectConfig` to the existing import from `../db/projects.js` (it already imports several names from there).

Then add the route after the `PATCH /api/projects/:id` handler (near line 99):

```js
/**
 * PUT /api/projects/:id/config — body { answers, draft? }
 * The setup wizard's save endpoint (token-free replacement for the PM intake
 * interview). `answers` is the camelCase wizard state. draft:true persists a
 * resumable draft under config.setup; a final save validates the pipeline's
 * required fields, writes canonical config + project.json, and marks setup
 * complete.
 */
router.put('/api/projects/:id/config', async (req, res) => {
  const project = await authorizeProject(req, res);
  if (!project) return;
  const body = req.body ?? {};
  if (!body.answers || typeof body.answers !== 'object') {
    res.status(400).json({ error: 'answers is required' });
    return;
  }
  const answers = normalizeAnswers(body.answers);

  if (body.draft) {
    const updated = await updateProjectConfig(project.id, {
      config: { setup: { status: 'draft', answers } },
    });
    res.json({ project: updated });
    return;
  }

  const errors = [];
  if (!answers.title.trim()) errors.push('title is required');
  if (!PROJECT_TYPES.includes(answers.projectType)) {
    errors.push(`projectType must be one of: ${PROJECT_TYPES.join(', ')}`);
  }
  if (!answers.researchQuestion.trim()) errors.push('research question is required');
  if (errors.length) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  const canonical = {
    title: answers.title.trim(),
    project_type: answers.projectType,
    research_question: answers.researchQuestion.trim(),
    deliverables: answers.deliverables,
    timeline: answers.timeline,
    source_materials: answers.sourceMaterials,
    ...(answers.notes ? { notes: answers.notes } : {}),
  };
  const { project: updated } = await applyProjectConfig(project.id, canonical, {
    extraConfig: { setup: { status: 'complete', answers } },
  });
  res.json({ project: updated });
});

/** Coerce a wizard answers payload to the expected shape/types (camelCase). */
function normalizeAnswers(a) {
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  return {
    title: typeof a.title === 'string' ? a.title : '',
    projectType: typeof a.projectType === 'string' ? a.projectType : '',
    researchQuestion: typeof a.researchQuestion === 'string' ? a.researchQuestion : '',
    deliverables: strArr(a.deliverables),
    timeline: typeof a.timeline === 'string' ? a.timeline : '',
    sourceMaterials: strArr(a.sourceMaterials),
    ...(typeof a.notes === 'string' && a.notes.trim() ? { notes: a.notes.trim() } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent-backend && npx vitest run src/routes/projects.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-backend/src/routes/projects.js agent-backend/src/routes/projects.test.js
git commit -m "Add PUT /api/projects/:id/config (wizard save: draft + final)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Remove the interview stage from the seeding pipeline

**Files:**
- Modify: `agent-backend/src/agents/seeding.js:30-48` (drop Stage 1) and remove `INTERVIEW_INPUT` (lines 173-183)
- Test: `agent-backend/src/agents/seeding.test.js`

**Interfaces:**
- Produces: `runSeedPipeline(projectId, { runTask })` now emits stages `research → skeleton → seeding` (no `interview`), dispatching `ra`, `advisor`, `writer`. If the project config lacks `title`/`research_question` it emits a single `seeding:error` and returns.

- [ ] **Step 1: Update the tests first**

In `agent-backend/src/agents/seeding.test.js`, update the first test's expectations and add a guard test. Replace the `'runs interview → research → skeleton …'` test with:

```js
  it('runs research → skeleton and writes pm/status.md', async () => {
    const runTask = makeRunTask();
    const events = await collect(runSeedPipeline(1, { runTask }));

    expect(stages(events)).toEqual([
      'research:start', 'research:done',
      'skeleton:start', 'skeleton:done',
      'seeding:done',
    ]);

    const calls = runTask.mock.calls.map(([task]) => task);
    expect(calls.map((t) => t.role)).toEqual(['ra', 'advisor', 'writer']);
    for (const task of calls) {
      expect(task.input).toContain(CONFIG.research_question);
      expect(task.projectId).toBe(1);
    }
    expect(calls.map((t) => t.context?.seedStage)).toEqual(['research', 'research', 'skeleton']);

    expect(writeProjectFile).toHaveBeenCalledWith(1, 'pm/status.md', expect.stringContaining('skeleton: ok'));
    expect(events.find((e) => e.type === 'file_change')).toMatchObject({ path: 'pm/status.md' });
  });

  it('aborts with a clear error when the project is not configured', async () => {
    getProject.mockResolvedValue({ id: 1, config: {} });
    const runTask = makeRunTask();
    const events = await collect(runSeedPipeline(1, { runTask }));
    expect(stages(events)).toEqual(['seeding:error']);
    expect(runTask).not.toHaveBeenCalled();
  });
```

Also review the rest of `seeding.test.js` and remove/adjust any remaining assertions that reference the `interview` stage, the `pm` role, or `do not dispatch` (the old "aborts when interview saves no config" test is replaced by the guard test above).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-backend && npx vitest run src/agents/seeding.test.js`
Expected: FAIL — current pipeline still emits `interview:*` and dispatches `pm`.

- [ ] **Step 3: Implement — drop Stage 1 and add the guard**

In `agent-backend/src/agents/seeding.js`, replace the Stage 1 block (lines ~30-48, from `// --- Stage 1: PM intake interview` through `yield { type: 'stage', stage: 'interview', status: 'done' };`) with:

```js
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
```

Delete the `INTERVIEW_INPUT` constant (lines ~173-183). Leave `describeProject`, `raInput`, `advisorInput`, `writerInput`, `writeStatusFile`, `forwardTask`, `forwardParallel` unchanged.

Update the module header comment (lines 12-21) to describe the flow as `research → skeleton` (intake handled by the wizard) rather than `interview → research → skeleton`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent-backend && npx vitest run src/agents/seeding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-backend/src/agents/seeding.js agent-backend/src/agents/seeding.test.js
git commit -m "Seeding pipeline: drop PM-interview stage (wizard owns intake)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Drop the interview stage from the webapp seeding panel

**Files:**
- Modify: `webapp/src/seeding.ts:22-27`

- [ ] **Step 1: Remove the interview stage row**

In `webapp/src/seeding.ts`, replace the `STAGES` array:

```ts
// The canonical pipeline order. `seeding` is the overall wrapper (not a row).
// Intake is handled by the setup wizard, not a pipeline stage.
const STAGES: StageDef[] = [
  { id: 'research', label: 'Build bibliography', owner: 'ra' },
  { id: 'skeleton', label: 'Generate skeleton', owner: 'writer' },
];
```

- [ ] **Step 2: Verify the build type-checks**

Run: `cd webapp && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add webapp/src/seeding.ts
git commit -m "Seeding panel: drop interview stage row

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite the PM prompt (remove interview/pressure; gentle nudging)

**Files:**
- Modify: `agent-backend/src/db/prompts/pm.md`

- [ ] **Step 1: Replace the intake-first framing (line 9)**

Old:
```
**You are the first agent the PI talks to.** When a PI starts a new project, you interview them, configure the project, and set up the agents.
```
New:
```
**Project intake is handled by the setup wizard, not by you.** By the time a PI is chatting with you, the project has been configured through the wizard (type, title, research question, deliverables, timeline, and any uploaded seed materials) and saved to `project.json`. Read that configuration and pick up from there. Reserve questions for genuine clarifications — never re-run an intake interview.
```

- [ ] **Step 2: Replace the "Running Inside the Kuhn Webapp" bullets (lines 13-19)**

Replace the bulleted list under `## Running Inside the Kuhn Webapp` with:

```
When you run as the `pm` agent inside the Kuhn webapp (rather than a CLI workspace), use the in-app tools:

- **Read the configuration first.** The setup wizard has already saved `project.json` (title, type, research question, deliverables, timeline, source materials). Start from it; do not ask for information the wizard already collected.
- **Ask only what you genuinely need with `ask_user`.** Use it for real clarifications or consequential decisions — one question at a time, adapting to answers. There is no time limit: if the PI steps away, your question simply waits for them. Never pressure the PI or issue a checklist of assignments.
- **Nudge gently when seed materials are thin.** If the project has little or no uploaded source material and it would materially improve the work, say so once, kindly — name the one or two kinds of materials that would help most and where to add them (the project files). Do not repeat the nudge or gate progress on it.
- **Organize uploaded materials with `move_file`.** If the PI has uploaded loose source documents (anything at the root that isn't one of the workspace's own folders — `draft/`, `guidance/`, `research/`, `review/`, `pm/`, `analyst/`, `writer/`, or an existing `seed_docs/`), move each into a `seed_docs/` folder with `move_file` so the Advisor can find them.
- **Dispatch background work with `dispatch_agent`** when the PI asks for it or when the plan clearly calls for it — the RA for literature, the Advisor for domain framing, etc. Each task description must be self-contained. **Exception:** when your task instructions say you are running inside the seeding pipeline, do not dispatch anyone.
- Sections of this document that mention shell commands, Python scripts, or `.venv` apply only to the CLI workspace; in the webapp you have the file tools and the tools above instead.
```

- [ ] **Step 3: Replace "Project Initialization" Step 1 (lines 32-54)**

Replace the `## Project Initialization` intro + `### Step 1: Interview the PI` block (through question 5) with:

```
## Project Initialization

The setup wizard configures the project before you enter the conversation: it collects the document type, title, research question, deliverables, timeline, and any seed materials, and saves them to `project.json`. Your job at initialization is to read that configuration, confirm it makes sense, gently flag anything thin (see "Nudge gently" above), and — outside the seeding pipeline — line up the right next steps. Do not re-interview the PI for details the wizard already captured.
```

Leave `### Step 2: Configure the project`, the Project Type Quick Reference, Subagent Dispatch, and everything below intact (they remain valid once intake is done).

- [ ] **Step 4: Re-seed and verify**

Run: `cd agent-backend && npm run db:seed`
Expected: completes without error.

Verify the stored prompt updated:
Run: `cd agent-backend && node -e "import('./src/db.js').then(async m => { const {rows} = await m.query('SELECT substr(system_prompt,1,120) AS p FROM agents WHERE slug=\$1',['pm']); console.log(rows[0].p); })"`
Expected: prints the new "Project intake is handled by the setup wizard" framing.

- [ ] **Step 5: Commit**

```bash
git add agent-backend/src/db/prompts/pm.md
git commit -m "PM prompt: wizard owns intake; gentle nudging, no pressure

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: API client + workspace store support

**Files:**
- Modify: `webapp/src/api.ts` (extend `Project.config`, add `WizardAnswers` + `saveProjectConfig`)
- Modify: `webapp/src/workspace.ts` (add `applyProjectUpdate`)

**Interfaces:**
- Produces:
  - `interface WizardAnswers { title: string; projectType: string; researchQuestion: string; deliverables: string[]; timeline: string; sourceMaterials: string[]; notes?: string }`
  - `saveProjectConfig(projectId: number, answers: WizardAnswers, draft: boolean): Promise<Project>`
  - `Project.config.setup?: { status: 'draft' | 'complete'; answers: Partial<WizardAnswers> }` plus optional `title`/`project_type`/`research_question`.
  - `workspace.applyProjectUpdate(project: Project): void`

- [ ] **Step 1: Extend the Project.config type and add the API function**

In `webapp/src/api.ts`, replace the `Project` interface's `config` field:

```ts
export interface WizardAnswers {
  title: string;
  projectType: string;
  researchQuestion: string;
  deliverables: string[];
  timeline: string;
  sourceMaterials: string[];
  notes?: string;
}

export interface Project {
  id: number;
  name: string;
  project_type: string;
  owner_id: string;
  org_id: number;
  /** Project config blob. `activeDocument` records the last-open file (story 006);
   *  `setup` holds the wizard's draft/complete state (setup wizard). */
  config?: {
    activeDocument?: string;
    title?: string;
    project_type?: string;
    research_question?: string;
    setup?: { status: 'draft' | 'complete'; answers: Partial<WizardAnswers> };
    [key: string]: unknown;
  };
}
```

Then add, in the Projects section (after `renameProject`):

```ts
/**
 * Save project setup from the wizard (token-free intake). draft=true persists a
 * resumable draft; draft=false is the final save (writes project.json, marks
 * setup complete). Returns the updated project.
 */
export async function saveProjectConfig(
  projectId: number,
  answers: WizardAnswers,
  draft: boolean,
): Promise<Project> {
  const res = await expectOk(
    await fetch(`${BACKEND_URL}/api/projects/${projectId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, draft }),
    }),
  );
  return ((await res.json()) as { project: Project }).project;
}
```

- [ ] **Step 2: Add the workspace store helper**

In `webapp/src/workspace.ts`, after `renameProject` (around line 170), add:

```ts
/** Merge an updated project row into the store (fires 'projects', and 'project' when active). */
export function applyProjectUpdate(project: Project): void {
  state.projects = state.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p));
  emit('projects');
  if (project.id === state.activeProjectId) emit('project');
}
```

(Confirm `Project` is already imported in `workspace.ts` — it is used by `createNewProject`. If not, add it to the existing `./api` import.)

- [ ] **Step 3: Verify the build type-checks**

Run: `cd webapp && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add webapp/src/api.ts webapp/src/workspace.ts
git commit -m "api/workspace: saveProjectConfig + applyProjectUpdate for wizard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: The setup wizard module

**Files:**
- Create: `webapp/src/wizard.ts`
- Modify: `webapp/src/style.css` (append wizard styles)
- Modify: `webapp/src/chat.ts` (export `startSeeding` is already exported; no change needed here — wizard imports it)

**Interfaces:**
- Consumes: `saveProjectConfig`, `uploadFiles`, `WizardAnswers` (api.ts); `applyProjectUpdate`, `projects`, `setActiveProject` (workspace.ts); `startSeeding` (chat.ts); `PROJECT_TYPES` (project-types.ts); `icon` (icons.ts).
- Produces: `openSetupWizard(projectId: number, opts?: { auto?: boolean }): void`

- [ ] **Step 1: Create the wizard module**

Create `webapp/src/wizard.ts`:

```ts
// Project setup wizard: a token-free, multi-step modal that collects project
// intake (type, title, research question, deliverables, timeline, seed uploads)
// and saves it via PUT /api/projects/:id/config — replacing the PM intake
// interview. Each step has a collapsible "What helps here?" guidance disclosure.
// Answers persist as a resumable draft on every step-advance and on abort;
// re-opening prefills from config.setup.answers. The final step asks whether to
// launch research + skeleton now (startSeeding) or later.

import { saveProjectConfig, uploadFiles, type WizardAnswers } from './api';
import { icon } from './icons';
import { PROJECT_TYPES } from './project-types';
import * as workspace from './workspace';
import { startSeeding } from './chat';

interface Step {
  key: string;
  title: string;
  render: (body: HTMLElement) => void;
  guidance: () => string; // HTML for the "What helps here?" disclosure
}

// Per-project-type seed-material guidance (used by the uploads step + the thin
// note on review). Keys mirror PROJECT_TYPES values.
const SEED_GUIDANCE: Record<string, string[]> = {
  manuscript: [
    'Key papers you are building on or citing',
    'Your dataset, results tables, or figures',
    'Any draft, outline, or abstract you already have',
    'Target journal + author guidelines',
  ],
  'rwe-protocol': [
    'Prior or template protocols',
    'A statistical analysis plan (SAP), if drafted',
    'Data dictionary / cohort definitions',
    'Relevant FDA guidance you must follow',
  ],
  'rct-protocol': [
    'Precedent trial protocols',
    'Draft endpoints or statistical plan',
    'Investigator brochure / product background',
    'Applicable ICH, CONSORT, or SPIRIT guidance',
  ],
  grant: [
    'The funder RFA / PA / solicitation',
    'Preliminary data and figures',
    'An aims page or prior application drafts',
    'Biosketches / team background',
  ],
  sop: [
    'Existing SOPs or templates',
    'Applicable regulatory standards (ISO / GxP)',
    'Process notes or validation data',
    'Related work instructions',
  ],
};

function seedListHtml(projectType: string): string {
  const items = SEED_GUIDANCE[projectType] ?? [
    'Any background documents you are working from',
    'Prior drafts, data, or key references',
  ];
  return `<ul>${items.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`;
}

// ---- Module state (one wizard at a time) ----
let overlay: HTMLElement | null = null;
let projectId = 0;
let stepIndex = 0;
let answers: WizardAnswers = blankAnswers();
let launchNow = true;
let saving = false;

function blankAnswers(): WizardAnswers {
  return {
    title: '', projectType: PROJECT_TYPES[0]?.value ?? 'manuscript',
    researchQuestion: '', deliverables: [], timeline: '', sourceMaterials: [],
  };
}

export function openSetupWizard(pid: number, opts: { auto?: boolean } = {}): void {
  projectId = pid;
  stepIndex = 0;
  launchNow = true;
  const project = workspace.projects().find((p) => p.id === pid);
  const saved = project?.config?.setup?.answers;
  answers = { ...blankAnswers(), ...(saved as Partial<WizardAnswers> | undefined) };
  // Seed the type from the creation-time choice when the wizard has no prior answer.
  if (!saved?.projectType && project?.project_type) answers.projectType = project.project_type;

  ensureOverlay();
  overlay!.hidden = false;
  render();

  // Auto-open stamps a draft immediately so the wizard auto-opens exactly once
  // ever; explicit re-entry from the project browser does not need this.
  if (opts.auto && !project?.config?.setup) void persistDraft();
}

function close(): void {
  if (overlay) overlay.hidden = true;
}

/** Abort: keep answers as a draft so re-entry prefills; do not launch anything. */
function abort(): void {
  void persistDraft();
  close();
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'setup-wizard';
  overlay.className = 'wz-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Project setup');
  document.body.append(overlay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) abort();
  });
}

async function persistDraft(): Promise<void> {
  try {
    const project = await saveProjectConfig(projectId, answers, true);
    workspace.applyProjectUpdate(project);
  } catch {
    /* draft persistence is best-effort */
  }
}

// ---- Steps ----
function steps(): Step[] {
  return [
    {
      key: 'type',
      title: 'What are you writing?',
      guidance: () =>
        `<p>Pick the closest match — it tunes the whole team (which literature the ` +
        `RA gathers, which conventions the Writer follows). You can change it later.</p>`,
      render: (body) => {
        const select = fieldSelect('Document type', answers.projectType,
          PROJECT_TYPES.map((t) => ({ value: t.value, label: t.label })),
          (v) => { answers.projectType = v; });
        const title = fieldText('Project title', answers.title,
          'e.g. GLP-1 receptor agonists and cardiovascular outcomes',
          (v) => { answers.title = v; });
        body.append(select, title);
      },
    },
    {
      key: 'focus',
      title: 'What is it about?',
      guidance: () =>
        `<p>One or two sentences on the central question or purpose. This is the ` +
        `single most useful thing you provide — the RA searches from it and the ` +
        `Writer frames the draft around it.</p>`,
      render: (body) => {
        body.append(fieldTextarea('Research question / purpose', answers.researchQuestion,
          'What are you trying to establish, and in whom?',
          (v) => { answers.researchQuestion = v; }));
      },
    },
    {
      key: 'scope',
      title: 'Deliverables & timeline',
      guidance: () =>
        `<p>Optional but helpful. Deliverables are the concrete outputs (e.g. ` +
        `"FDA RWE protocol", "manuscript for JAMA"). Use absolute dates in the ` +
        `timeline so the team can plan.</p>`,
      render: (body) => {
        body.append(fieldList('Deliverables', answers.deliverables,
          'Add a deliverable…', (list) => { answers.deliverables = list; }));
        body.append(fieldText('Timeline', answers.timeline,
          'e.g. Draft by 2026-08-01, submit by 2026-09-15',
          (v) => { answers.timeline = v; }));
      },
    },
    {
      key: 'seed',
      title: 'Add your materials',
      guidance: () =>
        `<p>The more you give the team to work from, the better the first draft. ` +
        `Helpful for this project type:</p>${seedListHtml(answers.projectType)}` +
        `<p>No materials? That's fine — the team will start from public literature.</p>`,
      render: (body) => {
        body.append(buildUploader());
      },
    },
    {
      key: 'review',
      title: 'Review & launch',
      guidance: () =>
        `<p>Launching now runs the research and skeleton steps from what you have. ` +
        `You can always add materials and re-run later.</p>`,
      render: (body) => {
        body.append(buildReview());
      },
    },
  ];
}

// ---- Rendering ----
function render(): void {
  if (!overlay) return;
  const list = steps();
  const step = list[stepIndex];
  const isLast = stepIndex === list.length - 1;

  const modal = document.createElement('div');
  modal.className = 'wz-modal';

  // Header: step counter + progress dots + title
  const head = document.createElement('header');
  head.className = 'wz-head';
  head.innerHTML =
    `<div class="wz-eyebrow">Project setup · ${stepIndex + 1} of ${list.length}</div>` +
    `<h2 class="wz-title"></h2>` +
    `<div class="wz-dots">${list.map((_, i) =>
      `<span class="wz-dot${i === stepIndex ? ' is-on' : ''}"></span>`).join('')}</div>`;
  (head.querySelector('.wz-title') as HTMLElement).textContent = step.title;

  // Body: the step's fields
  const body = document.createElement('div');
  body.className = 'wz-body';
  step.render(body);

  // Guidance disclosure ("rollup") — collapsed by default
  const details = document.createElement('details');
  details.className = 'wz-guide';
  details.innerHTML = `<summary>What helps here?</summary><div class="wz-guide-body">${step.guidance()}</div>`;

  // Footer: nav
  const foot = document.createElement('footer');
  foot.className = 'wz-foot';
  const left = document.createElement('div');
  const skip = textButton(stepIndex === 0 ? 'Skip for now' : 'Save & close', () => abort());
  skip.className = 'btn btn-quiet btn-sm';
  left.append(skip);

  const right = document.createElement('div');
  right.className = 'wz-foot-right';
  if (stepIndex > 0) {
    const back = textButton('Back', () => { stepIndex -= 1; render(); });
    back.className = 'btn btn-ghost btn-sm';
    right.append(back);
  }
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn btn-accent btn-sm';
  next.disabled = saving;
  next.textContent = isLast ? (launchNow ? 'Finish & launch' : 'Finish') : 'Next';
  next.addEventListener('click', () => void advance(isLast));
  right.append(next);

  foot.append(left, right);
  modal.append(head, body, details, foot);
  overlay.replaceChildren(modal);
}

async function advance(isLast: boolean): Promise<void> {
  // Per-step minimal gating: type+title on step 0, research question on step 1.
  const list = steps();
  const key = list[stepIndex].key;
  if (key === 'type' && !answers.title.trim()) { flashInvalid(); return; }
  if (key === 'focus' && !answers.researchQuestion.trim()) { flashInvalid(); return; }

  if (!isLast) {
    void persistDraft(); // fire-and-forget; keeps the draft resumable
    stepIndex += 1;
    render();
    return;
  }

  // Final save.
  saving = true;
  render();
  try {
    const project = await saveProjectConfig(projectId, answers, false);
    workspace.applyProjectUpdate(project);
    close();
    if (launchNow) {
      workspace.setActiveProject(projectId); // ensure the launched pipeline targets it
      void startSeeding();
    }
  } catch (err) {
    saving = false;
    render();
    const msg = document.createElement('div');
    msg.className = 'wz-error';
    msg.textContent = (err as Error).message;
    overlay?.querySelector('.wz-body')?.prepend(msg);
  } finally {
    saving = false;
  }
}

function buildReview(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wz-review';
  const typeLabel = PROJECT_TYPES.find((t) => t.value === answers.projectType)?.label ?? answers.projectType;
  const rows: [string, string][] = [
    ['Type', typeLabel],
    ['Title', answers.title || '—'],
    ['Focus', answers.researchQuestion || '—'],
    ['Deliverables', answers.deliverables.length ? answers.deliverables.join('; ') : '—'],
    ['Timeline', answers.timeline || '—'],
    ['Materials', answers.sourceMaterials.length ? `${answers.sourceMaterials.length} file(s)` : 'none'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'wz-review-row';
    const l = document.createElement('span'); l.className = 'wz-review-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'wz-review-value'; v.textContent = value;
    row.append(l, v);
    wrap.append(row);
  }

  // Gentle thin-seed nudge — informational, never blocking.
  if (answers.sourceMaterials.length === 0) {
    const note = document.createElement('div');
    note.className = 'wz-nudge';
    note.innerHTML =
      `${icon('info', { size: 14, stroke: 1.8 })} No materials added yet. The team will ` +
      `work from public literature — adding your own materials (e.g. ${escape(
        (SEED_GUIDANCE[answers.projectType] ?? ['prior drafts, data, or key references'])[0],
      )}) usually gives a much stronger first draft. You can add them now or later.`;
    wrap.append(note);
  }

  // Launch choice — the "always ask before running the pipeline" gate.
  const choice = document.createElement('div');
  choice.className = 'wz-launch';
  const mk = (val: boolean, label: string, sub: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wz-launch-opt${launchNow === val ? ' is-on' : ''}`;
    b.innerHTML = `<span class="wz-launch-label">${escape(label)}</span><span class="wz-launch-sub">${escape(sub)}</span>`;
    b.addEventListener('click', () => { launchNow = val; render(); });
    return b;
  };
  choice.append(
    mk(true, 'Start research & skeleton now', 'The RA builds a bibliography and the Writer drafts a skeleton.'),
    mk(false, 'Not yet', 'Just save the setup. You can launch anytime.'),
  );
  wrap.append(choice);
  return wrap;
}

function buildUploader(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wz-upload';

  const drop = document.createElement('label');
  drop.className = 'wz-drop';
  drop.innerHTML =
    `${icon('upload', { size: 18, stroke: 1.8 })}<span>Drop files here or click to choose</span>`;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'wz-file-input';
  drop.append(input);

  const fileList = document.createElement('div');
  fileList.className = 'wz-files';
  const renderFiles = () => {
    fileList.replaceChildren();
    for (const path of answers.sourceMaterials) {
      const chip = document.createElement('div');
      chip.className = 'wz-file-chip';
      chip.textContent = path.split('/').pop() ?? path;
      fileList.append(chip);
    }
  };
  renderFiles();

  const doUpload = async (files: File[]) => {
    if (!files.length) return;
    drop.classList.add('is-busy');
    const { uploaded, failed } = await uploadFiles(projectId, files, 'seed_docs');
    for (const u of uploaded) {
      if (!answers.sourceMaterials.includes(u.path)) answers.sourceMaterials.push(u.path);
    }
    drop.classList.remove('is-busy');
    renderFiles();
    void persistDraft();
    if (failed.length) {
      const err = document.createElement('div');
      err.className = 'wz-error';
      err.textContent = failed.map((f) => `${f.name}: ${f.error}`).join('; ');
      wrap.append(err);
    }
  };

  input.addEventListener('change', () => void doUpload(Array.from(input.files ?? [])));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    void doUpload(Array.from(e.dataTransfer?.files ?? []));
  });

  wrap.append(drop, fileList);
  return wrap;
}

// ---- Field builders ----
function fieldText(label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const f = fieldWrap(label);
  const input = document.createElement('input');
  input.className = 'wz-input';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  f.append(input);
  return f;
}

function fieldTextarea(label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLElement {
  const f = fieldWrap(label);
  const ta = document.createElement('textarea');
  ta.className = 'wz-textarea';
  ta.rows = 4;
  ta.value = value;
  ta.placeholder = placeholder;
  ta.addEventListener('input', () => onInput(ta.value));
  f.append(ta);
  return f;
}

function fieldSelect(
  label: string, value: string, options: { value: string; label: string }[], onChange: (v: string) => void,
): HTMLElement {
  const f = fieldWrap(label);
  const sel = document.createElement('select');
  sel.className = 'wz-select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  f.append(sel);
  return f;
}

function fieldList(label: string, value: string[], placeholder: string, onChange: (list: string[]) => void): HTMLElement {
  const f = fieldWrap(label);
  const items = [...value];
  const listEl = document.createElement('div');
  listEl.className = 'wz-chiplist';
  const row = document.createElement('div');
  row.className = 'wz-chip-add';
  const input = document.createElement('input');
  input.className = 'wz-input';
  input.placeholder = placeholder;
  const add = textButton('Add', () => commit());
  add.className = 'btn btn-ghost btn-sm';
  row.append(input, add);

  const renderChips = () => {
    listEl.replaceChildren();
    items.forEach((item, i) => {
      const chip = document.createElement('span');
      chip.className = 'wz-chip';
      chip.textContent = item;
      const x = textButton('×', () => { items.splice(i, 1); onChange([...items]); renderChips(); });
      x.className = 'wz-chip-x';
      chip.append(x);
      listEl.append(chip);
    });
  };
  const commit = () => {
    const v = input.value.trim();
    if (!v) return;
    items.push(v);
    input.value = '';
    onChange([...items]);
    renderChips();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  renderChips();
  f.append(listEl, row);
  return f;
}

function fieldWrap(label: string): HTMLElement {
  const f = document.createElement('div');
  f.className = 'wz-field';
  const l = document.createElement('label');
  l.className = 'wz-label';
  l.textContent = label;
  f.append(l);
  return f;
}

function textButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function flashInvalid(): void {
  const body = overlay?.querySelector('.wz-body');
  body?.classList.remove('wz-shake');
  void (body as HTMLElement | undefined)?.offsetWidth; // reflow to restart the animation
  body?.classList.add('wz-shake');
}

function escape(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
```

- [ ] **Step 2: Add wizard styles**

Append to `webapp/src/style.css` (adapt token names to the file's existing vars — mirror `.pb-overlay`/`.pb-modal` for the backdrop/surface, and reuse `--role`/spacing tokens found elsewhere):

```css
/* ---- Project setup wizard ---- */
.wz-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
  background: var(--overlay-bg, rgba(10, 12, 16, 0.55)); backdrop-filter: blur(2px); }
.wz-modal { width: min(560px, 92vw); max-height: 88vh; overflow: auto;
  background: var(--surface, #fff); color: var(--text, #111); border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.35); padding: 22px 22px 16px; }
.wz-eyebrow { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
.wz-title { margin: 4px 0 12px; font-size: 20px; }
.wz-dots { display: flex; gap: 6px; margin-bottom: 14px; }
.wz-dot { width: 22px; height: 3px; border-radius: 2px; background: var(--border, #ddd); }
.wz-dot.is-on { background: var(--accent, #3b6ef5); }
.wz-body { display: flex; flex-direction: column; gap: 14px; }
.wz-body.wz-shake { animation: wz-shake .25s; }
@keyframes wz-shake { 25% { transform: translateX(-5px);} 75% { transform: translateX(5px);} }
.wz-field { display: flex; flex-direction: column; gap: 5px; }
.wz-label { font-size: 12px; font-weight: 600; opacity: .8; }
.wz-input, .wz-textarea, .wz-select { width: 100%; padding: 8px 10px; border: 1px solid var(--border,#ddd);
  border-radius: 8px; background: var(--input-bg, #fafafa); color: inherit; font: inherit; }
.wz-textarea { resize: vertical; }
.wz-chiplist { display: flex; flex-wrap: wrap; gap: 6px; }
.wz-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
  background: var(--chip-bg, #eef1f6); font-size: 12px; }
.wz-chip-x { border: 0; background: none; cursor: pointer; font-size: 14px; line-height: 1; opacity: .6; }
.wz-chip-add { display: flex; gap: 6px; }
.wz-guide { margin: 14px 0 4px; border-top: 1px solid var(--border, #eee); padding-top: 10px; }
.wz-guide summary { cursor: pointer; font-size: 13px; font-weight: 600; opacity: .8; }
.wz-guide-body { font-size: 13px; line-height: 1.5; opacity: .85; margin-top: 8px; }
.wz-guide-body ul { margin: 6px 0 0 18px; }
.wz-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
.wz-foot-right { display: flex; gap: 8px; }
.wz-drop { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px;
  border: 1.5px dashed var(--border, #ccc); border-radius: 10px; cursor: pointer; text-align: center; font-size: 13px; }
.wz-drop.is-over { border-color: var(--accent, #3b6ef5); background: var(--accent-weak, #eef2ff); }
.wz-drop.is-busy { opacity: .6; pointer-events: none; }
.wz-file-input { display: none; }
.wz-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.wz-file-chip { padding: 3px 8px; border-radius: 6px; background: var(--chip-bg, #eef1f6); font-size: 12px; }
.wz-review-row { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border, #f0f0f0); font-size: 13px; }
.wz-review-label { width: 110px; opacity: .6; flex: none; }
.wz-review-value { flex: 1; }
.wz-nudge { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; padding: 10px 12px;
  background: var(--accent-weak, #eef2ff); border-radius: 8px; font-size: 13px; line-height: 1.45; }
.wz-launch { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.wz-launch-opt { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 10px 12px;
  border: 1.5px solid var(--border, #ddd); border-radius: 10px; background: none; cursor: pointer; }
.wz-launch-opt.is-on { border-color: var(--accent, #3b6ef5); background: var(--accent-weak, #eef2ff); }
.wz-launch-label { font-weight: 600; font-size: 13px; }
.wz-launch-sub { font-size: 12px; opacity: .7; }
.wz-error { color: var(--danger, #c0392b); font-size: 12px; margin-bottom: 8px; }
```

Confirm the icon names used (`info`, `upload`) exist:
Run: `cd webapp && grep -n "info\|upload" src/icons.ts | head`
If either is missing, use an existing near-equivalent from `icons.ts` (do not invent icon names).

- [ ] **Step 3: Verify the build type-checks**

Run: `cd webapp && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add webapp/src/wizard.ts webapp/src/style.css
git commit -m "Add project setup wizard modal (token-free intake)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire the entry points

**Files:**
- Modify: `webapp/src/chat.ts` (greeting CTA → injected setup handler)
- Modify: `webapp/src/main.ts` (auto-open once; wire the greeting handler; drop the sessionStorage guard)
- Modify: `webapp/src/project-browser.ts` (per-card "Set up / Resume setup" action)

**Interfaces:**
- Produces (chat.ts): `setSetupHandler(fn: (projectId: number) => void): void` — main wires this so the greeting CTA opens the wizard without chat importing wizard (avoids a chat↔wizard cycle).
- Consumes: `openSetupWizard` (wizard.ts) in main.ts and project-browser.ts.

- [ ] **Step 1: chat.ts — inject a setup handler and repoint the greeting CTA**

In `webapp/src/chat.ts`, add near the top-level module state:

```ts
// The greeting CTA opens the setup wizard; main wires this so chat.ts doesn't
// import wizard.ts (which imports startSeeding from here — would be a cycle).
let setupHandler: (projectId: number) => void = () => {};
export function setSetupHandler(fn: (projectId: number) => void): void { setupHandler = fn; }
```

In `appendGreeting()`, replace the body copy + CTA (lines ~549-559) with:

```ts
  body.innerHTML =
    `<p>Hi — I'm your project manager. Once your project is set up, I'll pull the ` +
    `literature and draft a working skeleton from your materials.</p>` +
    `<p>Set up takes a minute — or just start typing and set up later.</p>`;
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'btn btn-accent';
  cta.style.marginTop = '4px';
  cta.innerHTML = `Set up project ${icon('arrow-right', { size: 13, stroke: 2 })}`;
  cta.addEventListener('click', () => setupHandler(activeProjectId));
  body.append(cta);
```

(Confirm `activeProjectId` is the module-level project id used elsewhere in `chat.ts`; if the identifier differs, use that.)

- [ ] **Step 2: main.ts — wire the handler and auto-open the wizard once**

In `webapp/src/main.ts`:

Update the chat import (line 14) and add the wizard import:

```ts
import { initChat, setSetupHandler } from './chat';
import { openSetupWizard } from './wizard';
```

(Remove `startSeeding` from the chat import — it is no longer used in main once `maybeAutoGreet` is replaced.)

Replace `maybeAutoGreet` (lines 213-223) with:

```ts
// A brand-new project (no markdown yet) that was never set up: open the setup
// wizard automatically. It stamps a draft on open (config.setup) so it opens
// exactly once — after that, re-entry is manual from the project browser.
function maybeOpenSetupWizard(
  project: NonNullable<ReturnType<typeof workspace.activeProject>>,
): void {
  if (project.config?.title) return; // already configured
  if (project.config?.setup) return; // wizard already shown/aborted once
  openSetupWizard(project.id, { auto: true });
}
```

Update the call site (line 204) inside the `if (!doc)` block: change `maybeAutoGreet(project);` to `maybeOpenSetupWizard(project);`.

In `main()`, after `buildEditorHero();` (line 237), wire the greeting handler:

```ts
  setSetupHandler((projectId) => openSetupWizard(projectId));
```

- [ ] **Step 3: project-browser.ts — add a per-card setup action**

In `webapp/src/project-browser.ts`, add the import:

```ts
import { openSetupWizard } from './wizard';
```

Inside `render()`, in the project-card loop, after the `renameBtn` block (after line 190, before `wrap.append(...)`), add a setup button as another card sibling:

```ts
      // Setup / resume-setup control — opens the wizard prefilled from the draft.
      const setupState = project.config?.setup?.status;
      const setupBtn = document.createElement('button');
      setupBtn.type = 'button';
      setupBtn.className = 'pb-card-setup';
      const setupLabel = project.config?.title
        ? 'Edit setup'
        : setupState === 'draft' ? 'Resume setup' : 'Set up';
      setupBtn.title = setupLabel;
      setupBtn.setAttribute('aria-label', `${setupLabel} — ${project.name}`);
      setupBtn.innerHTML = icon('sliders', { size: 14, stroke: 1.8 });
      setupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        workspace.setActiveProject(project.id);
        close();
        openSetupWizard(project.id);
      });
```

Update the append line to include it:

```ts
      wrap.append(card, renameBtn, setupBtn);
```

Confirm the icon exists:
Run: `cd webapp && grep -n "sliders\|settings\|cog\|gear" src/icons.ts`
Use whichever settings-like icon `icons.ts` provides; if none, reuse `pencil` or another existing icon — do not invent a name.

Add a minimal style for the new button (append to `style.css`, mirroring `.pb-card-rename`):

```css
.pb-card-setup { position: absolute; top: 8px; right: 34px; /* left of the rename pencil */ }
```

(Adjust the offset to match how `.pb-card-rename` is positioned in the existing CSS — inspect it first with `grep -n "pb-card-rename" src/style.css`.)

- [ ] **Step 4: Verify the build type-checks**

Run: `cd webapp && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/chat.ts webapp/src/main.ts webapp/src/project-browser.ts webapp/src/style.css
git commit -m "Wire setup wizard: auto-open once, greeting CTA, project-browser action

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend test suite**

Run: `cd agent-backend && npm test`
Expected: PASS (all suites, including the updated questions/seeding/projects/runtime and new project-config tests).

- [ ] **Step 2: Webapp build**

Run: `cd webapp && npm run build`
Expected: PASS (tsc + vite build, no type errors).

- [ ] **Step 3: Manual end-to-end (running app)**

Start both apps (`npm run dev` at the repo root), then drive the browser (Playwright or by hand):

1. Create a new project (pick "Manuscript") → the **setup wizard opens automatically**, with type prefilled to Manuscript.
2. Advance through steps; open the "What helps here?" disclosure on the uploads step → per-type guidance shows. Upload a file → it appears as a chip.
3. On review, with no uploads confirm the **gentle thin-seed note** appears; choose "Not yet" and finish → no pipeline runs; `project.json` written.
4. Reopen the project browser → the card shows "Edit setup"; open it → **answers are prefilled**.
5. Create another new project, and on the auto-opened wizard click "Skip for now" → wizard closes; reload the page → **it does not auto-open again** (config.setup draft persisted); the project-browser card shows "Resume setup".
6. Complete a wizard with "Start research & skeleton now" → the seeding panel shows **research → skeleton** (no interview row) and the pipeline runs.
7. Trigger an `ask_user` question (e.g. chat with the PM in a way that prompts one) → the question card shows **no countdown**; wait > 1 minute → it stays pending (no auto-default).

- [ ] **Step 4: Update project-management records**

Per `CLAUDE.md` "Stories" rules, add/มark the owning story for this work in `docs/epics/…` (a new story or an entry in the relevant epic table) referencing this plan and spec. Commit.

- [ ] **Step 5: Final commit / branch wrap-up**

```bash
git add -A
git commit -m "Docs: record setup-wizard story + verification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Then use the `superpowers:finishing-a-development-branch` skill to decide merge/PR.

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- Wizard (deterministic, all fields + uploads + guidance disclosures + review gate) → Task 9. ✅
- Prefill / abort / resume → Task 9 (`openSetupWizard` prefill, `abort`→`persistDraft`) + Task 10 (project-browser re-entry). ✅
- Auto-open once → Task 10 (`maybeOpenSetupWizard`, `{auto:true}` stamps a draft). ✅
- New `PUT /api/projects/:id/config` (draft + final) → Task 4. ✅
- Shared save helper → Task 3. ✅
- Seeding pipeline drops interview stage → Task 5; webapp panel → Task 6. ✅
- Countdown removal (backend wait-indefinitely + card) → Tasks 1 & 2. ✅
- Gentle nudge (wizard review + PM prompt) → Task 9 (`wz-nudge`) + Task 7. ✅
- PM prompt rewrite → Task 7. ✅
- Tests → Tasks 1,3,4,5 (vitest) + Task 11 (manual). ✅

**Placeholder scan:** No TBD/TODO; every code step shows real code; edits give exact old/new text. Icon-name and CSS-offset uncertainties are handled with explicit `grep`-and-adapt steps (not silent placeholders). ✅

**Type consistency:** `WizardAnswers` (camelCase) is defined in Task 8 and consumed identically in Tasks 4 (wire shape), 9 (wizard). `applyProjectConfig(projectId, canonicalConfig, {extraConfig})` signature is identical in Tasks 3 & 4. `saveProjectConfig(projectId, answers, draft)` identical in Tasks 8 & 9. `setSetupHandler`/`openSetupWizard` names consistent across Tasks 9 & 10. ✅
