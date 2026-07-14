# Epic 002: Agent Orchestration Layer

**Status:** in-progress
**Created:** 2026-04-11
**Updated:** 2026-07-13 (031 shipped — the deterministic project setup wizard replaces the PM intake interview and the `ask_user` countdown; record written after the fact, see the story. 034 shipped — stray `# CLAUDE.md` preamble stripped from all six agent prompts. Open work is 022 live seeding verification (parked), 030 marker-syntax migration, the 031 follow-ups 032–033, 035 dead CLI instructions in prompts, 036 user interrupt of agent work. 037 shipped — chat-panel flex widening fixed)

## Goal

Build a testable prototype of the Kuhn webapp: a **single application** with agent chat, a
Milkdown markdown editor, and a file manager, backed by an agent runtime built on the
**Claude Agent SDK**. A test user can be interviewed by the PM agent, get a seeded project,
edit the document with `/cite` and `/write`, and preview a rendered PDF.

See [use-case.md](use-case.md) for the original product workflow (still valid for agent
behavior and seeding flow; its two-app/TeXlyre framing is superseded — see below).

## Key Design Decisions

### Revised 2026-06-11 (supersedes the 2026-04-13 table where they conflict)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent runtime | **Claude Agent SDK** | Don't rebuild the agent loop/tools/subagents/streaming; it's the runtime the `agents/` workspaces already prove out |
| Provider lock-in hedge | **Agent-task boundary** (`runAgentTask(role, projectId, input) → event stream`) | Abstract at the task interface, not the LLM call — keeps callers provider-neutral without tripling surface area |
| App topology | **Single app** (chat + editor + file manager) | The two-app split existed for AGPL isolation; moot with MIT editor stack |
| Editor | **Milkdown** (ProseMirror + remark, MIT, Yjs binding) | WYSIWYG markdown for non-LaTeX users; slash commands native to ProseMirror; license dissolves AGPL apparatus |
| Document format | **Markdown canonical**; Typst renders PDF; Pandoc exports docx/tex | Agent pipeline is markdown-native; deliverables are often Word |
| TeXlyre fork | **Removed** (story 023, 2026-06-12) | Kept only until the `/cite` port (016); preserved on its own remote (`soundtrip-health/texlyre@cite1`) |
| Tenancy invariants (now) | project-scoped rows/paths; single storage API enforcing project root; sandboxed execution | Cheap now, rewrite later; per-tenant KB + shared guidance corpus is a sales requirement |

### Still in force from 2026-04-13

- **Chat-first** workspace (but intake is a form, not an interview — see below)
- **DB-backed prompts** seeded from `agents/*/AGENTS.md`, editable at runtime
- **Full conversation logging** to Postgres (audit/replay)
- **Postgres + pgvector** via docker-compose
- **Own Yjs signaling + websocket servers**
- **Markdown handoffs / filesystem as shared agent memory**
- **Deterministic orchestration** — pipelines are code dispatching agent tasks, not agent-driven control flow

### Superseded

- ~~PM interview seeds projects~~ (2026-07-13, story 031) — intake moved to a
  deterministic, token-free **setup wizard**; the seeding pipeline runs
  research → skeleton from the wizard config, and the PM is clarifying-only.
  The interview spent model quota collecting form data, re-asked the project
  type, and pressured the PI; the `ask_user` countdown went with it.
- ~~Provider-agnostic LLM interface~~ (story 008) — replaced by the agent-task boundary
- ~~Custom agent router + tool registry~~ — the Agent SDK provides the loop and tools
- ~~Two separate apps / `/write` inside TeXlyre~~ — single app on Milkdown
- ~~Vanilla JS, no build step~~ — Vite + TypeScript (no UI framework); Milkdown is an npm dependency

## Prototype Scope

### Must Have

- [x] Agent runtime on Claude Agent SDK behind the agent-task boundary (011)
- [x] Single-app scaffold: chat UI + Milkdown editor + file manager shell (013)
- [x] Setup wizard configures the project, then seeding runs; RA + Advisor work during seeding (012, 015, 031 — live verification in 022, 032)
- [x] Storage API with project-root enforcement; all agent file access through it (018)
- [x] `/cite` ported to Milkdown: slash-command plugin, citation picker, chips, bib upsert (016)
- [x] `/write` slash command with streaming writer agent (017)
- [x] Typst render pipeline: markdown → PDF preview; Pandoc docx export (019)
- [ ] Durable job model for long-running agent work (part of 011)
- [ ] User can stop or redirect a running agent (036) — today the only interrupt is closing the tab

### Deferred

- Multi-user / auth (invariants only for now; see architecture.md)
- Analyst agent integration
- Reviewer adversarial loops
- Yjs room auth (do not expose beyond trusted test users)
- Git integration for project versioning
- Approval gates (prototype user IS the PI)

## Stories

### Phase 0: Foundation

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Map current agent patterns](stories/001-map-current-patterns.md) | done | M |
| 008 | LLM provider abstraction spike | superseded (Agent SDK + agent-task boundary) | — |

### Phase 1: Agent Backend

| # | Story | Status | Size |
|---|-------|--------|------|
| 009 | [Backend scaffold](stories/009-backend-scaffold.md) | done | L |
| 010 | [Database + seeding](stories/010-database-seeding.md) | done | L |
| 011 | [Agent runtime on Claude Agent SDK](stories/011-agent-runtime-sdk.md) — agent-task boundary, streaming, durable jobs | done | L |
| 012 | [PM agent](stories/012-pm-agent.md) — interview flow, project configuration, dispatch RA/Advisor | done | XL |
| 018 | [Storage API + sandboxed execution](stories/018-storage-sandboxing.md) — project-root enforcement, containerized rendering | done | M |
| 021 | [Per-agent model selection](stories/021-per-agent-models.md) — model tier per role on `agents.model`, env-overridable seed defaults | done | S |

### Phase 2: Webapp (single app)

| # | Story | Status | Size |
|---|-------|--------|------|
| 013 | [Webapp scaffold](stories/013-webapp-scaffold.md) — Vite + TS, chat UI, Milkdown editor pane, WebSocket to backend | done | L |
| 014 | [File manager](stories/014-file-manager.md) — upload, preview, delete/rename on the story-018 storage API; webapp-only | done | M |
| 015 | [Project seeding flow](stories/015-project-seeding.md) — PM interview → parallel agent research → skeleton generation, deterministic pipeline | done | XL |
| 020 | [Chat conversation restore & interview polish](stories/020-chat-conversation-restore.md) — transcript on reload, question-timeout UX, weighted token budget | done | M |
| 022 | [Live seeding & reload-resume verification](stories/022-live-seeding-verification.md) — run the scripted live-SDK checks deferred from 015/020 | deferred | S |
| 027 | [Reconnect a pending ask_user question after reload](stories/027-reconnect-pending-question.md) — detachable runs survive disconnect while parked; `pending` + `reconnect` endpoints re-render the question card on load (extends 020) | done | M |

### Phase 3: Editor depth

| # | Story | Status | Size |
|---|-------|--------|------|
| 016 | [Slash commands in Milkdown](stories/016-milkdown-slash-commands.md) — command plugin, `/cite` port from TeXlyre | done | L |
| 017 | [Writer agent + `/write`](stories/017-write-command.md) — streamed suggestion block with accept/reject (UI per the story 025 design spec; closes the 013 live-update issue) | done | XL |
| 019 | [Render & export](stories/019-render-export.md) — Typst PDF preview, Pandoc docx/tex export (on the 018 sandbox helpers) | done | L |

### Phase 4: UI design

| # | Story | Status | Size |
|---|-------|--------|------|
| 025 | [UI design implementation ("Column")](stories/025-ui-design-implementation.md) — tokens, shell, chat/seeding/question/editor/files restyle per `docs/design/handoff/` | done | L |

### Phase 5: Project setup

| # | Story | Status | Size |
|---|-------|--------|------|
| 031 | [Project setup wizard + calmer PM](stories/031-project-setup-wizard.md) — token-free intake modal replaces the PM interview; seeding runs from the saved config; `ask_user` countdown removed (supersedes the interview half of 012/015) | done | L |
| 032 | [Live verification of the wizard flow](stories/032-wizard-live-verification.md) — browser E2E deferred from 031; sibling of 022 | ready | S |
| 033 | ["Edit setup" loses answers on legacy-configured projects](stories/033-edit-setup-legacy-config.md) — no `config.setup` on pre-wizard projects, so the wizard reopens near-empty | ready | S |

### Cleanup & fixes

| # | Story | Status | Size |
|---|-------|--------|------|
| 023 | [Remove the TeXlyre fork](stories/023-remove-texlyre.md) — unblocked by 016 | done | S |
| 024 | [Collab plugin reload race](stories/024-collab-reload-race.md) — `editorState` ctx error on reload with a warm Yjs room | done | S |
| 026 | [Upload oversize error mapping](stories/026-upload-oversize-error-mapping.md) — backend `MulterError`→413 mapping; de-duplicate the size limit (surfaced by 014) | done | S |
| 028 | [Question card collapses to a sliver during seeding](stories/028-question-card-collapse.md) — flex `overflow:hidden` min-size 0; `flex-shrink:0` + `pre-wrap` (the real root cause behind the invisible-question reports) | done | S |
| 029 | [Transient model-provider error resilience](stories/029-transient-model-error-resilience.md) — backoff on 529/429/5xx + visible "retrying…" status + actionable Try-again (surfaced by a 529 hang on 2026-06-21) | done | S–M |
| 030 | [Marker syntax migration `[ ]` → `\x{}`](stories/030-marker-syntax-migration.md) — atomic switch across prompts + citation tooling + audit + render + editor to a backslash-command grammar (decided during the 2026-07-09 guidance ingestion) | draft | L |
| 034 | [Strip the stray `# CLAUDE.md` preamble from all six agent prompts](stories/034-agent-prompt-preamble.md) — every agent was told it's Claude Code working on a repo before it was told its role; live since PR #19 | done | S |
| 035 | [Prompts instruct agents to run a script that doesn't exist](stories/035-dead-cli-instructions-in-prompts.md) — `read_sections.py` + `.venv` blocks in pm/writer/ra/reviewer, with no shell tool and no such script (surfaced by the 034 audit) | ready | M |
| 036 | [Let the user stop or redirect agent work](stories/036-stop-and-redirect-agent-work.md) — no user-facing interrupt exists; the runtime mechanism does. Cancel endpoint + stop control + "stop and send" redirect | ready | M |
| 037 | [Chat panel widens and crushes the editor](stories/037-chat-panel-widens.md) — `flex: 0 0 380px` with no `min-width: 0`; one long URL took the panel to 692px. Fixed: `min-width: 0` + `overflow-wrap: anywhere` (`break-word` does not shrink min-content) | done | S |

### Preserved (may revisit)

| # | Story | Status | Size |
|---|-------|--------|------|
| 002 | [Survey orchestration frameworks](stories/002-survey-frameworks.md) | deferred | M |
| 003 | [Evaluate Anthropic SDKs](stories/003-evaluate-anthropic-sdks.md) | resolved by 2026-06-11 decision (Agent SDK adopted) | — |
| 004 | [Evaluate third-party frameworks](stories/004-evaluate-third-party.md) | deferred | L |
| 005 | [Evaluate custom build approach](stories/005-evaluate-custom-build.md) | deferred | M |
| 006 | [Orchestration spike](stories/006-orchestration-spike.md) | deferred | XL |
| 007 | [Recommendation & decision](stories/007-recommendation.md) | deferred | M |
