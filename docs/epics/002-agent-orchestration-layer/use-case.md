# Agent Webapp: Use-Case Spec (Prototype Scope)

**Status:** Draft
**Created:** 2026-04-13

## Overview

Kuhn's AI agents need a web interface. This document defines the user workflow, the two-surface architecture, and enough technical detail to build a working prototype that test users can play with.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Relationship to TeXlyre editor | **Separate apps** | AGPL isolation; independent evolution; cleaner API boundary |
| Agent workspace primary UI | **Chat-first** + file manager | PM interview is conversational; file manager for uploads/browsing |
| Agent workspace frontend | **Vanilla JS** | Minimal framework dependence; no React/Vue/Svelte build step |
| Writer agent in editor | **`/command` first** | Lightweight integration; side panel later |
| LLM provider | **Provider-agnostic** | Abstract behind a common interface; no Anthropic lock-in |
| Signaling/sync server | **Both y-webrtc signaling + y-websocket** | Bundled in agent webapp backend; replaces broken external servers |
| Backend | **Node.js** | Shared language with texlyre; hosts agent API + signaling + file mgmt |
| Conversation persistence | **Per-session UI, full log in DB** | UI shows current session; backend logs everything for audit/replay |
| Agent prompts | **DB-backed, seeded from CLAUDE.md** | Editable at runtime; initial seed from existing agent CLAUDE.md files |
| Database | **Postgres + pgvector** | Docker container; pgvector enables future semantic search |
| Tool registration | **Custom registry** | Simple name/schema/handler; maps to any LLM's tool-use format; MCP later if needed |

## Two-Surface Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│      Agent Workspace        │     │       TeXlyre Editor         │
│      (new webapp)           │     │   (existing, separate app)   │
│                             │     │                              │
│  ┌───────────┐ ┌──────────┐│     │  ┌────────────────────────┐  │
│  │  Chat UI  │ │  File    ││     │  │  CodeMirror 6 editor   │  │
│  │  (agents) │ │  Manager ││     │  │  LaTeX / Typst         │  │
│  └─────┬─────┘ └────┬─────┘│     │  └──────────┬─────────────┘  │
│        │             │      │     │             │                │
│        └──────┬──────┘      │     │    /write command            │
│               │             │     │    (writer agent chat)       │
│               ▼             │     │             │                │
│  ┌──────────────────────┐   │     │             │                │
│  │  WebSocket / REST    │   │     │             │                │
│  └──────────┬───────────┘   │     └─────────────┼────────────────┘
└─────────────┼───────────────┘                   │
              │                                   │
              ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Backend (Node.js)                       │
│                                                                 │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  Agent   │ │ Yjs       │ │  File    │ │  Compilation     │  │
│  │  Router  │ │ Signaling │ │  Storage │ │  Proxy           │  │
│  │  + LLM   │ │ + WS      │ │  API     │ │  (LaTeX/Typst)   │  │
│  └──────────┘ └───────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
     shared project storage (filesystem / git)
```

The two apps share a backend and project storage, but have independent frontends. The AGPL editor code stays in its own build. The agent webapp, agent backend, and all proprietary logic live outside the AGPL boundary.

## User Workflow

### Phase 1: Project Seeding (Agent Workspace)

The user opens the agent workspace. The PM agent greets them and begins the interview.

**Step 1 — PM Interview**

The PM asks structured questions (adapted from the existing PM protocol):

1. What type of document? (RWE protocol, RCT protocol, grant, manuscript, SOP, other)
2. What is it about? (subject, research question, therapeutic area)
3. What materials do you already have? (guidance docs, prior work, key papers)
4. Key deliverables and timeline?
5. Editing workflow preferences?

The user answers in natural language. The PM extracts structure from the conversation.

**Step 2 — Document Upload**

During or after the interview, the user uploads existing documents via the file manager:
- FDA guidance documents, RFAs, journal guidelines
- Prior protocols or manuscripts to build on
- Key papers, data dictionaries, preliminary results

Uploaded files appear in the file manager. The PM acknowledges them and routes to the appropriate agent (Advisor for guidance docs, RA for references, Analyst for data).

**Step 3 — Agent Research**

Based on the interview and uploads, agents work in parallel:
- **Advisor** ingests uploaded guidance, builds structured summaries in the knowledge base
- **RA** searches PubMed, bioRxiv, ClinicalTrials.gov for relevant literature; populates `references.bib`
- **PM** creates project configuration and status files

The user sees agent activity in the chat (streaming). They can ask questions, redirect, or provide additional context.

**Step 4 — Skeleton Generation**

Once the knowledge base and references are seeded:
- **PM** dispatches Writer to generate a document skeleton
- **Writer** produces `draft/main.tex` (or `.typ`) with section structure, TODOs, and initial citations
- The skeleton appears in the file manager; user can preview it

**Handoff point:** The project is seeded. The user can continue chatting with agents in the workspace, or open the project in TeXlyre to start writing.

### Phase 2: Writing (TeXlyre Editor)

The user opens the project in TeXlyre. The document loads in the editor.

**`/write` command** — The user types `/write` (or a keybinding) to invoke the writer agent. A small chat modal appears (similar to the existing `/cite` modal). The user describes what they want:

- "Expand the methods section based on the RWE guidance"
- "Add a power analysis subsection — analyst already ran the numbers"
- "Rewrite the introduction to emphasize the unmet need"

The writer agent streams a response, which may include:
- Direct edits to the document (applied via the editor API)
- Questions back to the user ("Which estimand framework should I use?")
- Spawning sub-agents (RA for citations, Advisor for domain questions)

The user reviews, accepts/rejects edits, and continues writing.

**Other `/commands` (future):**
- `/cite <query>` — already implemented (Epic 3)
- `/review` — route current section to Reviewer
- `/ask <question>` — consult Advisor
- `/figure <desc>` — generate figure via Analyst
- `/status` — project overview from PM

### Phase 3: Review Cycles (Both Surfaces)

For major revisions, the user returns to the agent workspace:
- PM dispatches Reviewer for a full document review
- Reviewer reports appear in chat and as files
- PM triages: critical issues to user, minor issues to Writer
- Writer makes revisions; user reviews in TeXlyre

This cycle repeats until the document is ready.

## Agent Workspace UI

### Chat Panel (primary)

- Full-height chat interface, left side
- Messages from user and agents
- Agent messages tagged with agent name/role
- Streaming responses with typing indicators
- Markdown rendering (code blocks, tables, lists)
- Inline file references (clickable links to file manager)

### File Manager (secondary)

- Right side panel, collapsible
- Tree view of project files
- Upload via drag-and-drop or file picker
- File preview (text, PDF, images)
- Download individual files
- Status indicators (new, modified, generated)

### Layout

```
┌──────────────────────────────────────────────┐
│  Kuhn Agent Workspace    [project-name]  [?] │
├────────────────────────────┬─────────────────┤
│                            │                 │
│  PM: What type of doc...   │  project/       │
│                            │  ├── draft/     │
│  User: An RWE protocol     │  │   ├── main…  │
│  for a diabetes study...   │  │   └── ref…   │
│                            │  ├── guidance/  │
│  PM: Great. I'll set up    │  │   └── rwe…   │
│  the knowledge base...     │  └── pm/        │
│                            │      └── sta…   │
│  [RA searching PubMed...]  │                 │
│                            │                 │
│  RA: Found 12 relevant     │                 │
│  papers. Top 3: ...        │                 │
│                            │                 │
│ ┌────────────────────────┐ │                 │
│ │ Type a message...   [→]│ │                 │
│ └────────────────────────┘ │                 │
└────────────────────────────┴─────────────────┘
```

## Writer Agent in TeXlyre (`/write` command)

### Interaction Model

1. User types `/write` or presses keybinding (e.g., `Ctrl+Shift+W`)
2. `/write` text is consumed (same pattern as `/cite`)
3. A chat modal appears anchored near the cursor
4. User types a request; writer agent streams a response
5. If the response includes document edits, they appear as a diff/preview
6. User accepts, rejects, or refines
7. Modal dismisses; edits are applied to the document

### What the Writer Agent Sees

- The current document content (or relevant sections for large docs)
- Cursor position and selected text
- Project context: `references.bib`, guidance summaries, PM status
- Conversation history within the current `/write` session

### Integration Boundary

The `/write` command in TeXlyre communicates with the agent backend via REST/WebSocket. TeXlyre itself has no LLM code — it sends context and receives structured responses (text, edits, citations). This keeps the AGPL boundary clean.

```
TeXlyre (/write command)          Agent Backend
─────────────────────             ─────────────
  POST /api/agent/write
  {                          →    Route to Writer agent
    context: "...",               Writer calls Claude API
    selection: "...",             Writer may spawn RA, Advisor
    hints: "expand methods"       Stream response chunks
  }                          ←    { type: "text", content: "..." }
                             ←    { type: "edit", range: ..., text: "..." }
                             ←    { type: "citation", key: "smith2024", ... }
                             ←    { type: "done" }
```

## Backend Services (Prototype Scope)

### Agent Router + LLM

- Receives requests from both frontends
- Routes to appropriate agent (PM, Writer, RA, etc.)
- Each agent is a system prompt (from DB) + tools configuration
- Calls LLM via provider-agnostic interface (streaming)
- Logs all interactions to DB (messages, tool calls, responses, tokens)
- Per-session conversation state in memory; full history persisted to DB
- Handles inter-agent dispatch (Writer spawns RA, etc.)

### Database (Postgres + pgvector)

- **Docker container:** `pgvector/pgvector` image, zero-install for developers
- Stores agent prompts (seeded from `agents/*/AGENTS.md` on first run, editable at runtime)
- Stores tool definitions (name, description, JSON Schema; handler implementations in code)
- Logs all conversations (messages, tool calls, responses, token counts, timestamps)
- Project metadata and configuration
- pgvector extension enables future semantic search (over conversation history, documents, knowledge base)

### Tool Registry

- Tools are defined in the DB: name, description, parameter JSON Schema, agent assignments
- Handler implementations live in code (a tool ID maps to an async function)
- Each agent has a list of tool IDs it can use (configurable in DB)
- Tool schemas are translated to the active LLM provider's format at call time
- Seeded with initial tools on first run:

| Tool | Used By | Description |
|------|---------|-------------|
| `file_read` | All | Read a project file |
| `file_write` | Writer, Analyst | Write/update a project file |
| `file_list` | All | List project directory contents |
| `pubmed_search` | RA | Search PubMed for papers |
| `arxiv_search` | RA | Search arXiv/bioRxiv |
| `web_search` | RA, Advisor | General web search |
| `spawn_agent` | PM, Writer | Dispatch a sub-agent task |

- MCP can be added later as a tool backend type (adapter registers MCP server tools into the registry)

### Yjs Signaling + WebSocket Server

- **y-webrtc signaling:** enables peer-to-peer document sync between editor instances
- **y-websocket server:** reliable fallback when WebRTC fails; also enables server-side document access
- Replaces the broken external `ywebrtc.texlyre.org` server
- Minimal: use the reference implementations from Yjs ecosystem

### File Storage API

- CRUD operations on project files
- Upload endpoint (for agent workspace file manager)
- Serves files to both frontends
- Projects stored on filesystem, git-trackable
- Each project is a directory with the standard layout (`draft/`, `guidance/`, `pm/`, etc.)

### Compilation Proxy

- Accepts `.tex` or `.typ` files, returns PDF
- Wraps `pdflatex`/`xelatex` or `typst compile`
- Can defer to later epics if texlyre already has a working compiler setup

## Prototype Scope — What to Build First

The goal is a working prototype that test users can interact with. Cut scope aggressively.

### Must Have (prototype)

1. **Agent workspace with PM chat** — vanilla JS; user can converse with PM agent; streaming responses
2. **File manager** — upload files, browse project tree, basic preview
3. **Agent backend** — Node.js; provider-agnostic LLM interface (Claude first); agent routing
4. **Postgres + pgvector** — docker-compose; agent prompts, tool definitions, conversation logs
5. **Tool registry** — DB-backed definitions, code handlers; file ops + PubMed search for prototype
6. **PM agent end-to-end** — interview → configure project → dispatch RA/Advisor
7. **Writer agent via `/write` in TeXlyre** — basic request/response with streaming; edits shown as suggestions
8. **Yjs signaling + WebSocket server** — bundled, replaces external servers
9. **Project storage** — filesystem-based, one project at a time

### Defer

- Multi-user / auth (prototype is single-user local)
- Analyst agent integration (no data pipeline yet)
- Reviewer adversarial loops (PM + Writer + RA are the core loop)
- Side panel chat in TeXlyre (start with modal)
- Compilation proxy (use texlyre's existing compiler config)
- Git integration for project versioning
- Approval gates / PI confirmation flows (prototype user IS the PI)

## Resolved Design Questions

1. **Frontend stack:** Vanilla JS — no framework, no build step, minimal dependencies. The agent workspace is a chat + file manager, not a complex SPA.

2. **LLM provider abstraction:** Provider-agnostic. The backend defines a common interface for chat completions with streaming and tool use. Implementations for Anthropic (Claude), OpenAI, etc. sit behind that interface. No SDK lock-in.

3. **Handoff (workspace → editor):** Keep simple for prototype. Exact mechanism TBD during build — likely an "Open in Editor" button that launches/navigates to TeXlyre with the project path.

4. **Conversation persistence:** Per-session in the UI (chat clears on new session). Backend logs all agent interactions to a database — every message, tool call, and response. This enables audit trails, replay, and future features (cross-session context, analytics).

5. **Agent prompts:** Stored in a database, not hardcoded. Seeded on first run from the existing `agents/*/AGENTS.md` and `agents/AGENTS.md` files. Editable at runtime (admin UI or API). This decouples prompt iteration from code deploys.

## Resolved — All Design Questions

All major architectural decisions have been made. See the Key Design Decisions table above for the complete list. The spec is ready for implementation.
