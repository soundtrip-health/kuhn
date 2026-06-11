# Epic 002: Agent Orchestration Layer

**Status:** in-progress
**Created:** 2026-04-11
**Updated:** 2026-06-11

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
| TeXlyre fork | **Retired to reference** | Keep `texlyre/` until `/cite` is ported, then remove |
| Tenancy invariants (now) | project-scoped rows/paths; single storage API enforcing project root; sandboxed execution | Cheap now, rewrite later; per-tenant KB + shared guidance corpus is a sales requirement |

### Still in force from 2026-04-13

- **Chat-first** workspace; PM interview seeds projects
- **DB-backed prompts** seeded from `agents/*/AGENTS.md`, editable at runtime
- **Full conversation logging** to Postgres (audit/replay)
- **Postgres + pgvector** via docker-compose
- **Own Yjs signaling + websocket servers**
- **Markdown handoffs / filesystem as shared agent memory**
- **Deterministic orchestration** — pipelines are code dispatching agent tasks, not agent-driven control flow

### Superseded

- ~~Provider-agnostic LLM interface~~ (story 008) — replaced by the agent-task boundary
- ~~Custom agent router + tool registry~~ — the Agent SDK provides the loop and tools
- ~~Two separate apps / `/write` inside TeXlyre~~ — single app on Milkdown
- ~~Vanilla JS, no build step~~ — Vite + TypeScript (no UI framework); Milkdown is an npm dependency

## Prototype Scope

### Must Have

- [x] Agent runtime on Claude Agent SDK behind the agent-task boundary (011)
- [ ] Single-app scaffold: chat UI + Milkdown editor + file manager shell (013)
- [ ] PM agent conducts interview, seeds project; RA + Advisor work during seeding (012, 015)
- [x] Storage API with project-root enforcement; all agent file access through it (018)
- [ ] `/cite` ported to Milkdown; `/write` slash command with streaming writer agent (016, 017)
- [ ] Typst render pipeline: markdown → PDF preview; Pandoc docx export (019)
- [ ] Durable job model for long-running agent work (part of 011)

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
| 012 | [PM agent](stories/012-pm-agent.md) — interview flow, project configuration, dispatch RA/Advisor | draft | XL |
| 018 | [Storage API + sandboxed execution](stories/018-storage-sandboxing.md) — project-root enforcement, containerized rendering | done | M |

### Phase 2: Webapp (single app)

| # | Story | Status | Size |
|---|-------|--------|------|
| 013 | [Webapp scaffold](stories/013-webapp-scaffold.md) — Vite + TS, chat UI, Milkdown editor pane, WebSocket to backend | ready | L |
| 014 | File manager — upload, browse project tree, preview files | draft | M |
| 015 | Project seeding flow — PM interview → agent research → skeleton generation | draft | XL |

### Phase 3: Editor depth

| # | Story | Status | Size |
|---|-------|--------|------|
| 016 | [Slash commands in Milkdown](stories/016-milkdown-slash-commands.md) — command plugin, `/cite` port from TeXlyre | ready | L |
| 017 | Writer agent + `/write` — streaming edits into the document with accept/reject | draft | XL |
| 019 | [Render & export](stories/019-render-export.md) — Typst PDF preview, Pandoc docx/tex export (on the 018 sandbox helpers) | draft | L |

### Preserved (may revisit)

| # | Story | Status | Size |
|---|-------|--------|------|
| 002 | [Survey orchestration frameworks](stories/002-survey-frameworks.md) | deferred | M |
| 003 | [Evaluate Anthropic SDKs](stories/003-evaluate-anthropic-sdks.md) | resolved by 2026-06-11 decision (Agent SDK adopted) | — |
| 004 | [Evaluate third-party frameworks](stories/004-evaluate-third-party.md) | deferred | L |
| 005 | [Evaluate custom build approach](stories/005-evaluate-custom-build.md) | deferred | M |
| 006 | [Orchestration spike](stories/006-orchestration-spike.md) | deferred | XL |
| 007 | [Recommendation & decision](stories/007-recommendation.md) | deferred | M |
