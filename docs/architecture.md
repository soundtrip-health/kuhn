# System Architecture

> **Status:** Active — revised 2026-06-11. Markdown-first editor (Milkdown), agent runtime on the
> Claude Agent SDK, and multi-tenancy invariants adopted. This supersedes the TeXlyre-based
> architecture finalized 2026-04-17 ([Epic 001](epics/001-editor-foundation-research/index.md));
> see [Decision Revisions](#decision-revisions-2026-06-11) below.

## Overview

Kuhn is a web application for scientific and technical writing with integrated AI agents. One app,
three surfaces:

1. **Editor** — a browser-based WYSIWYG markdown editor (Milkdown) with citations, math,
   cross-references, and slash commands
2. **Agent chat** — conversational interface to the six agents (PM interview, project seeding,
   review cycles)
3. **File manager** — project tree, uploads, previews

A Node.js backend hosts the agent runtime, project storage, rendering/export, and Yjs
collaboration servers.

For the operator's view — where data is persisted, how it is processed, and what leaves
the machine — see [data-pipeline.md](data-pipeline.md) (story 040).

## Document Format Strategy

- **Canonical authoring format: markdown** (Pandoc/Quarto flavor) with BibTeX (`.bib`)
  bibliographies. This matches the agent pipeline, which has always been markdown-native
  (markdown handoffs, `draft/main.md`, citation keys).
- **Rendering: Typst** — markdown → Typst → PDF for live preview and final output. Templates
  handle journal/funder formatting so users never touch typesetting.
- **Export: Pandoc** — `.docx` (critical: FDA submissions and most collaborator workflows are
  Word), `.tex` (escape hatch for LaTeX-native collaborators and journal submission), HTML.
- **LaTeX is an export target, not an authoring surface.** Fine-grained formatting is the
  toolchain's job (and increasingly the agents'), not the user's.

What markdown alone can't express, the flavor supplies: `[@citekey]` citations, cross-references,
captioned figures/tables, math (LaTeX syntax inside `$...$`).

## High-Level Components

```
┌────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                      │
│                                                             │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Milkdown Editor │  │  Agent Chat  │  │ File Manager │   │
│  │  - WYSIWYG md    │  │  - PM/agents │  │ - tree/upload│   │
│  │  - /commands     │  │  - streaming │  │ - preview    │   │
│  │  - Yjs collab    │  │              │  │              │   │
│  └────────┬─────────┘  └──────┬───────┘  └──────┬───────┘   │
│           └───────────────────┼─────────────────┘           │
│                     WebSocket / REST                        │
└───────────────────────────────┼─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                      Backend (Node.js)                       │
│                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Agent       │ │ Storage API │ │ Render/  │ │ Yjs      │   │
│  │ Runtime     │ │ (project-   │ │ Export   │ │ signaling│   │
│  │ (Claude     │ │  root       │ │ (Typst,  │ │ + WS     │   │
│  │  Agent SDK) │ │  enforced)  │ │  Pandoc) │ │          │   │
│  └──────┬──────┘ └─────────────┘ └──────────┘ └──────────┘   │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐    │
│  │ SQLite: prompts, conversations, jobs, projects,       │    │
│  │ references (all rows project/tenant-scoped)           │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
        project storage: per-project directories (git-trackable)
```

## Editor Foundation

**Decision (2026-06-11):** Build the editor on **Milkdown** (MIT) — a plugin-driven WYSIWYG
markdown editor framework on ProseMirror + remark, with a first-class Yjs binding.

**Refinement (Epic 004, 2026-06-13):** The hand-rolled Milkdown build was replaced with
**Milkdown Crepe** (the Notion-style distribution, on `CrepeBuilder`) — toolbar, block-edit
slash menu, block handle, image/table/code-mirror/latex features out of the box. Yjs collab and
Kuhn's custom surface (citation chips, `/cite`, `/write`, agent slash commands folded into one
menu) re-attach to `crepe.editor`. Crepe's slash menu is Notion-style: it opens only when a
block's text starts with `/` (the retired `slash.ts` matched mid-block) — an accepted change.

Why Milkdown:

- **Audience fit** — target users (protocol, grant, SOP authors) are Word/Docs people, not
  LaTeX people. Typora-style inline WYSIWYG markdown is the right surface; the agents are the
  product, the editor must not be a barrier.
- **Slash commands are native** to the ProseMirror ecosystem — better fit than the CodeMirror 6
  retrofit used for `/cite` in the TeXlyre fork.
- **Yjs binding** — we already run y-webrtc signaling and y-websocket servers; collaboration
  carries over.
- **MIT license** — dissolves the AGPL open-core apparatus entirely (see
  [strategy.md](../strategy.md)). No public-fork obligation, no legally mandated app split.

Consequences:

- **Single app.** The "two separate apps" split (agent workspace vs. editor) existed for AGPL
  isolation. With an MIT editor stack, chat, editor, and file manager are one application.
- **TeXlyre fork removed.** The `/cite` backend logic (PubMed grounding, bib management,
  Epic 003) was ported; only the editor-side UI was rebuilt as a Milkdown/ProseMirror plugin.
  The port completed with story 002-016 and the fork (plus the unused `web-citation/`
  reference module) was deleted in story 002-023 (2026-06-12) — git history preserves both.

## Agent Runtime

**Decision (2026-06-11):** Build agent execution on the **Claude Agent SDK** rather than a custom
router + provider-agnostic LLM interface. The SDK provides the agent loop, tool use, subagent
spawning, MCP, sessions, and streaming — the same runtime the `agents/` workspaces already run on
(Claude Code).

**Lock-in hedge — abstract at the agent-task boundary, not the LLM-call boundary.** The backend's
internal contract is:

```
runAgentTask({
  role,        // pm | writer | analyst | advisor | research | review
  projectId,   // project root the task may touch
  input,       // user message or dispatch instruction
  context,     // selection, cursor, file refs
}) → stream of events: { text_delta | text | file_change | citation | question |
                          question_expired | done | error }   (+ stage markers from pipelines)
```

Everything above this interface (routes, UI, job model, logging) is provider-neutral. The Claude
Agent SDK is an implementation detail behind it; a second implementation can be added later
without touching callers. We do **not** abstract chat-completion calls — that triples surface
area (tool formats, streaming, caching semantics) and forfeits the provider features that
determine agent quality.

**Kept from the original design:**

- **DB-backed prompts** — agent system prompts in SQLite, seeded from `agent-backend/src/db/prompts/*.md`
  (+ `seed-data.js`), editable at runtime
- **Conversation logging** — every message, tool call, and response persisted (audit, replay,
  future semantic search)
- **Markdown files as agent handoffs** — the filesystem is shared memory; the project directory
  is the coordination medium (battle-tested in the CLI workflow)
- **Deterministic orchestration** — multi-agent pipelines (e.g., seeding: interview → advisor
  ingest → RA search → skeleton) are code that dispatches agent tasks, not an agent improvising
  control flow

**Added:**

- **Durable job model** — long-running agent work (seeding, full review) is a persisted job with
  task state, progress streaming to the UI, resumability after crash, and per-run token budgets

**Dropped/superseded:**

- Custom agent loop and tool registry (the SDK's tool/MCP mechanism replaces it; project file
  tools are enforced by the Storage API, see below)
- Provider-agnostic chat-completion interface (story 008 — superseded)

## Multi-Tenancy Invariants

Full multi-tenancy (auth, orgs, quotas, billing) remains deferred, but three invariants are
adopted **now** so that adding it later is auth + quotas, not a rewrite:

1. **Everything is project-scoped.** Every DB row and file path carries a `project_id` (and a
   tenant/owner column from the start, even while it has one value). A future multi-tenant
   path (e.g. a hosted Postgres) is then `tenant_id` + row-level security, not a rewrite.
2. **One storage API, project-root enforced.** All agent and frontend file access goes through a
   single storage service that resolves paths inside the project root — no traversal, no symlink
   following. Agents never get raw filesystem access outside their project.
3. **All execution is sandboxed, even single-user.** Typst/Pandoc rendering, analyst Python, and
   any future terminal run in per-session containers. Document compilation is arbitrary code
   execution; treat it that way from day one.

Also planned (not yet built): auth on Yjs rooms (currently anyone with a doc id can join — do not
expose beyond trusted test users).

### Knowledge Base Tenancy

The advisor's knowledge base is **per-tenant by default**:

- **Tenant KB** — guidance summaries, source docs, and project knowledge belong to the tenant
  that uploaded them. Never shared across tenants. This is a sales requirement in the target
  market (FDA/clinical/grant writers will ask about data isolation before uploading a protocol).
- **Shared guidance corpus** — a separate, Kuhn-curated, read-only library of public guidance
  (FDA guidance documents, ICH guidelines, NIH/funder instructions, journal author guidelines).
  Any tenant can pull from it according to their project type. Tenant uploads never flow into it;
  curation is an explicit, Kuhn-side editorial act.

## Slash Commands

| Command | Agent | Action |
|---------|-------|--------|
| `/cite <query>` | Research | Search PubMed/bioRxiv, insert `[@citekey]` + update `.bib` |
| `/write <request>` | Writer | Contextual drafting/edits at cursor or selection |
| `/research <question>` | Research | Quick literature lookup, return summary |
| `/figure <description>` | Analyst | Generate a figure via Python, insert it |
| `/review` | Reviewer | Critique the current section |
| `/ask <question>` | Advisor | Domain expertise question |
| `/status` | PM | Project status summary |

Implemented as ProseMirror/Milkdown plugins calling the agent-task API.

## Data Model

- Projects are directories on disk (git-trackable), accessed only via the Storage API
- Documents are markdown (`.md`); references canonically in SQLite, with `.bib` derived for rendering
- Figures and tables in `figures/` and `tables/`
- **Path is identity.** Files have no id column, deliberately — storage is the
  source of truth and every DB row that refers to a file is keyed by its path
  (`comments`, `pending_edits`, `file_seen`, `file_events`, and
  `projects.config.activeDocument`). A move is therefore not a delete plus a
  create: it is a tracked, identity-preserving `moved` event whose consumers
  are all re-keyed in one transaction (`db/move-paths.js`, story 012-002).
  Anything new that keys off a path must be added to that rewrite — the
  header comment there carries the authoritative audit of path columns.
  Path matching is **byte-exact**, so a case-only rename on a
  case-insensitive filesystem is not treated as a no-op.
- **Folders are just directories.** Nesting has always been allowed by the
  storage layer; story 012-001 exposes it in the UI. An empty folder is
  working-tree-only state — git cannot track it, so it survives reloads and
  the per-file restore, but it is invisible to version history.
- Agent prompts, conversations, jobs, references, and project metadata in SQLite (project/tenant-scoped)
- Tenant KB under the tenant's storage; shared guidance corpus in a separate global store

## Decision Revisions (2026-06-11)

| Earlier decision | Revision | Why |
|---|---|---|
| TeXlyre fork as editor foundation (Epic 001, 2026-04-17) | Milkdown-based markdown editor; TeXlyre retired to reference | Audience is not LaTeX-native; agents are markdown-native; MIT removes AGPL burden |
| LaTeX primary / Typst supported | Markdown canonical; Typst renders; LaTeX + docx are exports | Formatting is automatable; deliverables are often Word |
| Two separate apps (AGPL isolation) | Single app | Isolation rationale was the AGPL license; gone with Milkdown |
| Custom agent router + provider-agnostic LLM interface | Claude Agent SDK behind an agent-task boundary | Don't rebuild an agent runtime; hedge lock-in at the task interface |
| Multi-tenancy fully deferred | Three invariants now (scoping, storage API, sandboxing) + per-tenant KB / shared guidance corpus | Cheap now, expensive to retrofit; isolation is a sales blocker in target market |

## Open Questions

- [ ] Typst template library: which journal/funder targets first?
- [ ] Tracked changes / suggestion mode in Milkdown (ProseMirror has prior art) — needed for PI review workflows
- [ ] Auth provider choice when multi-user lands
- [ ] Server-side vs. client-side Typst rendering (server default; WASM later for offline)
