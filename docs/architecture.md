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
│  │ Postgres + pgvector: prompts, conversations, jobs,    │    │
│  │ projects (all rows project/tenant-scoped)             │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
        project storage: per-project directories (git-trackable)
```

## Editor Foundation

**Decision (2026-06-11):** Build the editor on **Milkdown** (MIT) — a plugin-driven WYSIWYG
markdown editor framework on ProseMirror + remark, with a first-class Yjs binding.

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
- **TeXlyre fork retired** to reference material. The `/cite` backend logic (PubMed grounding,
  bib management, Epic 003) ports; only the editor-side UI is rebuilt as a Milkdown/ProseMirror
  plugin. The port completed with story 002-016 (2026-06-12); `texlyre/` removal is owned by
  story 002-023.

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

- **DB-backed prompts** — agent system prompts in Postgres, seeded from `agents/*/AGENTS.md`,
  editable at runtime
- **Conversation logging** — every message, tool call, and response persisted (audit, replay,
  future semantic search via pgvector)
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
   tenant/owner column from the start, even while it has one value). Postgres path: single DB,
   `tenant_id` + row-level security. pgvector rows are scoped the same way.
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
- Documents are markdown (`.md`); bibliography in BibTeX (`.bib`)
- Figures and tables in `figures/` and `tables/`
- Agent prompts, conversations, jobs, and project metadata in Postgres (project/tenant-scoped)
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
