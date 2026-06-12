# Story 015: Project Seeding Flow

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** XL
**Completed:** 2026-06-12

## Goal

The full seeding flow from [use-case.md](../use-case.md) Phase 1: a new project goes
from PM interview to a working starting point — project configuration, initial
bibliography, domain-guidance groundwork, and a skeleton draft — in one streamed,
observable pipeline.

## Design

**Deterministic orchestration** (epic key decision: "pipelines are code dispatching
agent tasks, not agent-driven control flow"). Story 012 let the PM dispatch RA/Advisor
itself via `dispatch_agent`; that remains available for ad-hoc chat, but the seeding
pipeline is code:

```
POST /api/projects/:id/seed   (SSE stream)
  └─ stage "interview"  — PM intake interview (ask_user round trip), save_project_config.
  └─ stage "research"   — RA and Advisor run in parallel as independent top-level tasks:
       RA      → draft/references.bib + research/literature-summary.md
       Advisor → guidance/ summaries + guidance/index.md
  └─ stage "skeleton"   — Writer reads project.json / references.bib / guidance/index.md,
       writes draft/main.md (section structure, TODOs, initial citations)
  └─ pm/status.md       — written by the pipeline itself (deterministic summary)
```

Each stage is a separate top-level `runAgentTask`, so each gets its own (story 020
weighted) token budget instead of one shared tree budget. Stage boundaries are emitted
as `{ type: 'stage', stage, status: 'start'|'done'|'error' }` events on the same SSE
stream as the agent events, so the chat panel can narrate progress.

Failure policy: an interview that produces no project configuration aborts the
pipeline; a failed research branch is reported but does not block the skeleton
(a draft without references is still useful); a skeleton failure ends the pipeline
with an error stage event. `pm/status.md` records per-stage outcomes either way.

## Acceptance Criteria

- [x] `POST /api/projects/:id/seed` streams the full pipeline as SSE: stage events
      plus the underlying agent events (text/question/file_change/done/error)
- [x] Interview stage: PM asks questions via the existing `ask_user` round trip and
      saves the configuration; pipeline verifies `projects.config` was written and
      aborts otherwise; PM is instructed not to dispatch sub-agents in this flow
- [x] Research stage: RA and Advisor run in parallel with self-contained,
      config-derived instructions; RA targets `draft/references.bib` +
      `research/literature-summary.md`, Advisor targets `guidance/`
      (`ra` and `advisor` gain the `file_write` tool)
- [x] Skeleton stage: Writer produces `draft/main.md` from the seeded artifacts,
      with section structure, TODO markers, and only real citation keys
- [x] `pm/status.md` written by the pipeline with stage outcomes and artifact list
- [x] Webapp: a Seed button starts the pipeline; stage progress and agent events
      render in the chat panel; ask_user questions work over the seed stream;
      file changes refresh the file tree
- [ ] One live end-to-end seeding run against the SDK + DB — deferred to
      [Story 022](022-live-seeding-verification.md) (live runs burn the
      subscription quota; scripted check provided there)

## Implementation

- `agent-backend/src/agents/seeding.js` — `runSeedPipeline()` async generator;
  parallel research via `EventChannel`; `pm/status.md` written in code; stage
  instructions built from `projects.config`
- `POST /api/projects/:id/seed` (routes/projects.js) over the shared
  `routes/sse.js#streamEvents` helper (extracted from routes/agent.js)
- `db/seed.js`: `file_write` granted to `ra` and `advisor` (re-run
  `node src/db/seed.js` on existing databases)
- `agents/pm/AGENTS.md`: PM skips dispatching when its task says it is running
  inside the seeding pipeline
- Webapp: Seed button (topbar) → `chat.ts#startSeeding()`; stage markers render
  as system lines; agent/question events go through the same handler as chat
- Tests: `seeding.test.js` (stage sequencing, config-abort, non-fatal research
  failure, parallel interleave, early-termination cleanup × 2), `projects.test.js`

## Known Issues

- Live end-to-end seeding run not yet exercised against the SDK.
  **Deferred to [Story 022](022-live-seeding-verification.md)**
  (`webapp/scripts/seed-check.mjs` is ready to drive it).

## Out of Scope

- Upload UI for source materials (story 014 file manager); uploads via the storage
  API work today and the Advisor stage handles an empty `guidance/`
- Durable resume of a half-finished pipeline (re-running seed overwrites artifacts)
- Analyst involvement during seeding (deferred epic-wide)
