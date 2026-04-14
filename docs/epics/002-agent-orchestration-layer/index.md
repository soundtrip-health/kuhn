# Epic 002: Agent Orchestration Layer

**Status:** in-progress
**Created:** 2026-04-11
**Updated:** 2026-04-13

## Goal

Build a working agent webapp prototype — a separate web application where users interact with AI agents to seed, manage, and write scientific documents. Integrate a writer agent into the TeXlyre editor via `/write` command. Ship a prototype that test users can play with.

See [use-case.md](use-case.md) for the full product workflow and design decisions.

## Context

The current agent system (`agents/`) is built on Claude Code — each agent is a workspace with a CLAUDE.md, orchestrated via human conversation. Moving to a webapp requires:

1. **Agent Workspace** (new webapp) — chat-first interface where the PM agent interviews users, agents research and seed projects, and users manage project files
2. **Writer integration in TeXlyre** — `/write` command that connects to the agent backend for contextual writing assistance
3. **Agent Backend** (Node.js) — routes requests to agents, calls Claude API with streaming, manages project files, and hosts Yjs signaling/WebSocket servers

### Key Design Decisions (2026-04-13)

- **Separate apps** — agent workspace and TeXlyre editor are independent frontends sharing a backend. This avoids AGPL infection and allows independent evolution.
- **Chat-first** — the agent workspace is primarily a chat interface with a file manager, not a document editor.
- **`/write` command first** — writer agent in TeXlyre starts as a modal triggered by `/write`, not a persistent side panel.
- **Own signaling server** — both y-webrtc signaling and y-websocket bundled in the agent backend, replacing broken external servers.

## Prototype Scope

### Must Have

- [ ] Agent workspace frontend (chat UI + file manager)
- [ ] PM agent conducts interview, seeds project
- [ ] RA and Advisor agents work during seeding (search literature, build knowledge base)
- [ ] Writer agent generates document skeleton
- [ ] `/write` command in TeXlyre with streaming writer agent
- [ ] Agent backend with routing, streaming, and Claude API integration
- [ ] Yjs signaling + WebSocket server (replaces external servers)
- [ ] Filesystem-based project storage

### Deferred

- Multi-user / auth (prototype is single-user local)
- Analyst agent integration
- Reviewer adversarial loops
- Side panel chat in TeXlyre
- Compilation proxy
- Git integration for project versioning
- Approval gates (prototype user IS the PI)

## Stories

### Phase 0: Foundation

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Map current agent patterns](stories/001-map-current-patterns.md) | done | M |
| 008 | LLM provider abstraction spike — provider-agnostic interface with streaming + tool use | draft | M |

### Phase 1: Agent Backend + Signaling

| # | Story | Status | Size |
|---|-------|--------|------|
| 009 | [Backend scaffold](stories/009-backend-scaffold.md) — Node.js server, docker-compose (Postgres+pgvector), Yjs signaling + WebSocket | done | L |
| 010 | Database + seeding — Postgres schema, seed agent prompts + tool definitions from AGENTS.md, conversation logging | draft | L |
| 011 | Agent router — route requests to agents, LLM streaming, conversation history, inter-agent dispatch | draft | XL |
| 012 | PM agent — interview flow, project configuration, dispatch RA/Advisor | draft | XL |

### Phase 2: Agent Workspace Frontend

| # | Story | Status | Size |
|---|-------|--------|------|
| 013 | Agent workspace scaffold — vanilla JS app, chat UI, WebSocket connection to backend | draft | L |
| 014 | File manager — upload, browse project tree, preview files | draft | M |
| 015 | Project seeding flow — PM interview → agent research → skeleton generation | draft | XL |

### Phase 3: TeXlyre Integration

| # | Story | Status | Size |
|---|-------|--------|------|
| 016 | `/write` command in TeXlyre — modal UI, context extraction, backend API call | draft | L |
| 017 | Writer agent — streaming responses, document edits, sub-agent spawning (RA) | draft | XL |

### Preserved (may revisit)

| # | Story | Status | Size |
|---|-------|--------|------|
| 002 | [Survey orchestration frameworks](stories/002-survey-frameworks.md) | deferred | M |
| 003 | [Evaluate Anthropic SDKs](stories/003-evaluate-anthropic-sdks.md) | deferred | L |
| 004 | [Evaluate third-party frameworks](stories/004-evaluate-third-party.md) | deferred | L |
| 005 | [Evaluate custom build approach](stories/005-evaluate-custom-build.md) | deferred | M |
| 006 | [Orchestration spike](stories/006-orchestration-spike.md) | deferred | XL |
| 007 | [Recommendation & decision](stories/007-recommendation.md) | deferred | M |
