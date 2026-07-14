# Project setup wizard + calmer PM — design

**Date:** 2026-07-13
**Status:** approved (design)
**Author:** Bob Dougherty (with Claude)

## Problem

Project intake today is an agent conversation run by the PM, and it has three UX
problems:

1. **Redundant.** The user picks a project type at creation (`project-browser.ts`
   → `POST /api/projects`, stored in `projects.project_type`), then the PM's first
   interview question re-asks "what type of document are you writing?" and its
   `save_project_config` overwrites the column. Nothing feeds the creation choice
   into the interview as a default.
2. **Wasteful.** Everything the PM interviews for — type, title, research question,
   deliverables, timeline, source materials — is structured data a deterministic
   form can collect without spending model tokens. The "smart" PM chat should be
   reserved for things that actually need it (clarifying questions, coordination).
3. **Pressuring.** The `ask_user` question card shows a 15-minute countdown backed
   by a real backend `setTimeout` that auto-defaults on expiry
   (`config.js` → `questions.js` → `runtime.js`). If the PI steps away mid-
   conversation the job "continues with defaults." Combined with the PM's post-
   interview dispatch of assignments, a new user is met with a pressure campaign
   instead of a calm start.

## Goals

- Replace the PM intake **interview** with a deterministic, token-free **project
  setup wizard** in the webapp.
- Reserve PM **chat** for genuine clarifying questions and gentle nudging.
- The wizard **runs by default** when a new project is created, is **abortable**,
  and is **re-triggerable later with previous answers prefilled**.
- The wizard includes **helpful guidance** via collapsible disclosures ("rollups"),
  e.g. explaining what seed materials help for the chosen project type.
- **Remove the countdown / auto-default.** If the PI steps away, the question just
  waits.
- When seed info is thin, **nudge gently** rather than blocking or pressuring.

## Non-goals

- No change to the research→skeleton generation logic itself (RA/Advisor/Writer
  stage prompts are unchanged).
- No new "rollup" framework — "rollups" here means ordinary collapsible
  disclosure sections inside the wizard.
- No redesign of the file manager; the wizard reuses the existing upload API.

## Design overview: three lanes

| Lane | Owner | Token cost | Responsibility |
|------|-------|-----------|----------------|
| **Setup wizard** | webapp (deterministic) | none | All structured intake + seed uploads; writes config |
| **Seeding pipeline** | backend (deterministic) | RA/Advisor/Writer stages | research → skeleton; runs only after explicit "start now" |
| **PM chat** | `pm` agent (on demand) | on demand | Clarifying questions, gentle nudging, coordination |

The PM-interview **stage is removed** from the seeding pipeline; intake comes from
the wizard.

## 1. The wizard (`webapp/src/wizard.ts`, new)

A multi-step **modal overlay**, matching the existing `project-browser.ts` overlay
style and `style.css` tokens. It is a plain TS module (no framework), one concern:
collect and persist project setup.

### Steps

1. **Type & title** — project type selector **prefilled from the creation-time
   `project_type`**; project title (stored as `config.title`; the project *name*
   the user chose at creation is left intact).
2. **Focus** — research question / subject (`config.research_question`).
3. **Scope** — deliverables (editable list, `config.deliverables`) + timeline
   (`config.timeline`, absolute dates encouraged via helper text).
4. **Seed materials** — drag/drop upload into the project via the existing upload
   API, plus a collapsible **"What helps here?"** disclosure whose content is
   **tailored per project type** (e.g. RWE protocol → prior protocols, SAP, data
   dictionary; manuscript → key papers, data, draft figures; grant → funder RFA,
   preliminary data; SOP → applicable standards; RCT → precedent protocols,
   CONSORT). Uploaded filenames become `config.source_materials`.
5. **Review & launch** — summary of all answers, plus the **"always ask" gate**:
   **"Start research & skeleton now"** vs **"Not yet."** When **seed info is
   thin**, a gentle inline note explains what would improve results —
   informational, never blocking. "Thin" is defined concretely as **no uploaded
   seed materials** (`config.source_materials` empty); the note names the
   project-type-specific materials that would help (same content as the step-4
   disclosure).

Uploaded files land in the project immediately via the upload API (even in a
draft) and persist if the wizard is aborted; `config.source_materials` is derived
from what has been uploaded.

Every step has a collapsible guidance disclosure ("rollup"), **collapsed by
default**. Guidance content lives in a small per-project-type map in the module
(or a sibling `wizard-guidance.ts`).

### Prefill / abort / resume

- Answers persist to `config.setup` on each step-advance and on abort (see §3).
- Re-opening prefills every field from `config.setup.answers`.
- **Aborting** closes the wizard, keeps `config.setup.status = 'draft'`, and does
  **not** run the pipeline.

### Entry points

- **Auto-open on new project:** `main.ts` `maybeAutoGreet` opens the wizard
  (instead of calling `startSeeding`) when `config.setup` is **absent** and the
  project has no content. On first open it writes an empty `draft` setup so the
  wizard **auto-opens exactly once ever** — reloads/other tabs won't re-nag.
- **Manual re-entry:** a **"Set up project" / "Resume setup"** action in
  `project-browser.ts` (project card / menu), prefilled from the draft.
- The chat greeting CTA (`chat.ts`) is reworded to point gently at the wizard
  rather than "Start project interview".

## 2. API client (`webapp/src/api.ts`)

- `saveProjectConfig(projectId, config, { draft })` → `PUT /api/projects/:id/config`.
- Reuse the existing file-upload endpoint the file manager uses for step 4 (no new
  upload API).

## 3. Backend: config persistence

### Shared helper (`agent-backend/src/agents/project-config.js`, new)

Extract the save logic currently inline in `runtime.js`'s `save_project_config`
tool (`updateProjectConfig` + write `project.json` + report a `file_change`) into a
reusable function so the agent tool and the new REST endpoint share one code path:

```
applyProjectConfig(projectId, config) -> { project, created }
```

It performs `updateProjectConfig(projectId, { projectType: config.project_type,
config })` and writes `project.json`. Event emission stays at the call sites (the
agent tool pushes to its channel; the REST route publishes to the project feed).

### New endpoint (`agent-backend/src/routes/projects.js`)

`PUT /api/projects/:id/config` — body `{ config, draft? }`, authorized via the
existing `authorizeProject`.

- **`draft: true`** — merge partial answers under `config.setup`
  (`{ status: 'draft', answers }`). Do **not** write `project.json`; do **not**
  set canonical top-level config fields; do **not** mark complete.
- **final (default)** — validate required fields (`title`, `research_question`,
  and a valid `project_type`), write the canonical config fields + `project.json`
  via `applyProjectConfig`, and set `config.setup = { status: 'complete', answers }`.
  Publish a `file_change` for `project.json` to the project feed.

`config.setup = { status: 'draft' | 'complete', answers: { … } }` is the single
source of truth for both prefill and the auto-open decision.

Validation mirrors the current `save_project_config` schema: `project_type` ∈
`['rwe-protocol','rct-protocol','grant','manuscript','sop']`, `title` and
`research_question` non-empty, `deliverables` an array, `timeline` a string,
`source_materials` an array.

## 4. Seeding pipeline (`agent-backend/src/agents/seeding.js`)

- **Remove Stage 1 (PM interview)** and the `INTERVIEW_INPUT` constant.
  `runSeedPipeline` now reads the wizard-saved `project.config` and runs
  **research → skeleton** only.
- Keep a **missing-config guard** as a safety net: if `config.title` or
  `config.research_question` is absent, abort with a clear stage error (should not
  happen because the wizard requires them, but the pipeline must not run on empty
  config).
- `POST /api/projects/:id/seed` is unchanged; it is now triggered by the wizard's
  "Start research & skeleton now" (or later, when the user resumes and launches).

### Webapp seeding panel (`webapp/src/seeding.ts`)

- Drop the `interview` stage from `STAGES`; the panel now shows **research →
  skeleton**. The `interview` stage marker no longer arrives from the backend.

## 5. Countdown removal (wait indefinitely)

- **`config.js`** — `questionTimeoutMs` defaults to **null** (no timeout). The
  `AGENT_QUESTION_TIMEOUT_MS` env override is preserved (a number re-enables it).
- **`questions.js`** — `waitForReply(jobId, timeoutMs, meta)`: when `timeoutMs` is
  `null`/`0`, do **not** create a `setTimeout`; park until `deliverReply` or
  `cancelQuestion`. `deliverReply`/`cancelQuestion` already `clearTimeout(timer)` —
  guard for the no-timer case.
- **`runtime.js`** `ask_user` — unchanged logic; a `null` reply now only occurs on
  task teardown (`cancelQuestion`). The graceful "continue with sensible defaults"
  message stays for that teardown path. The `question_expired` push remains but now
  signals teardown, not a timer.
- **`question-card.ts`** — remove the visible countdown clock, the depletion bar,
  the `DEFAULT_SECONDS`/`tick`/timer machinery, and the "Defaults if it expires"
  copy. The pending card shows the question with "Type your answer in the chat box
  below." `markExpired` (teardown only) is reworded from "No response in time …
  continued with defaults" to a neutral "This question is no longer active."

## 6. PM prompt (`agent-backend/src/db/prompts/pm.md`)

Rewrite so the PM no longer owns intake and no longer pressures:

- **Remove Step 1 (Interview the PI)** and the "Interview with `ask_user`" +
  "Save the configuration with `save_project_config`" webapp instructions — the
  wizard owns intake now. (The `project_config`/`ask_user` tools may remain
  assigned for edge cases, but the default flow no longer interviews.)
- Recast "You are the first agent the PI talks to / interview them" (lines 9, 34)
  to: the project is configured by the setup wizard; the PM picks up from the saved
  config.
- Add a **gentle nudge** directive: when seed materials / config are thin, the PM
  suggests (once, kindly) what would help — it does **not** issue an assignment
  campaign or repeatedly prompt.
- Remove any language implying a countdown / deadline on user replies.

Reseed with `npm run db:seed` after editing.

## Data model summary

`projects.config` (JSON) gains:

```jsonc
{
  // canonical fields (written only on wizard completion / agent save):
  "title": "...",
  "project_type": "manuscript",
  "research_question": "...",
  "deliverables": ["..."],
  "timeline": "...",
  "source_materials": ["seed_docs/foo.pdf"],
  "notes": "...",
  // wizard state (written on every step + abort):
  "setup": {
    "status": "draft" | "complete",
    "answers": { "title": "...", "projectType": "...", "researchQuestion": "...",
                 "deliverables": ["..."], "timeline": "...", "sourceMaterials": ["..."],
                 "notes": "..." }
  }
}
```

`project_type` remains a first-class column (set at creation, updated on wizard
completion) — no longer re-asked before the column is trusted.

## Testing

- **`project-config` helper** (vitest) — writes config + `project.json`; idempotent.
- **`PUT /api/projects/:id/config`** — draft vs final behavior; validation; auth via
  `authorizeProject`; draft does not write `project.json`; final does and marks
  complete.
- **`seeding` pipeline** — update existing tests: no `interview` stage; research →
  skeleton runs from pre-saved config; missing-config guard aborts cleanly.
- **`questions` / `ask_user`** — no-timeout path parks until reply/cancel and never
  auto-resolves; the timer path still works when a timeout is configured.
- **Webapp** — existing token-free check scripts exercise the wizard open →
  fill → save → launch flow; verify auto-open-once and resume-prefill.

## Files touched

**New**
- `webapp/src/wizard.ts` (+ optional `wizard-guidance.ts`)
- `agent-backend/src/agents/project-config.js`
- Tests: `agent-backend/src/agents/project-config.test.js`, route test additions

**Modified**
- `webapp/src/main.ts` — `maybeAutoGreet` opens the wizard once
- `webapp/src/project-browser.ts` — "Set up / Resume setup" action
- `webapp/src/chat.ts` — greeting CTA points at the wizard; keep `question` wiring
- `webapp/src/question-card.ts` — remove countdown / depletion / defaults copy
- `webapp/src/seeding.ts` — drop `interview` stage
- `webapp/src/api.ts` — `saveProjectConfig`
- `webapp/src/style.css` — wizard styles
- `agent-backend/src/routes/projects.js` — `PUT /api/projects/:id/config`
- `agent-backend/src/agents/seeding.js` — remove interview stage + `INTERVIEW_INPUT`
- `agent-backend/src/agents/runtime.js` — `save_project_config` uses shared helper
- `agent-backend/src/config.js` — `questionTimeoutMs` default null
- `agent-backend/src/agents/questions.js` — no-timeout path
- `agent-backend/src/db/prompts/pm.md` — remove interview/pressure; gentle nudging

## Open questions / risks

- **`project.json` shape** stays the canonical config object (title, project_type,
  research_question, deliverables, timeline, source_materials, notes) — the `setup`
  draft is DB-only and is **not** written to `project.json`.
- **Chat transcript restore** filtered out `seedStage: 'interview'` job prompts
  (story 020); removing the interview stage means there is simply nothing to filter
  there — verify no restore logic depends on that stage existing.
