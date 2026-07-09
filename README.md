# Kuhn

A web-based scientific and technical writing tool with integrated AI assistance.

Kuhn is a browser-based WYSIWYG markdown editor where AI agents deliver real-time help as you
write manuscripts, protocols, and grant applications. You author in friendly markdown with
BibTeX; the toolchain renders to PDF via Typst and exports to Word/LaTeX via Pandoc — so LaTeX
is an export target, never a prerequisite.

What's in place today:

- **Agent-integrated editing** — six specialized agents (PM, Writer, Research Assistant,
  Advisor, Reviewer, Analyst) embedded in the editor, with token-streaming chat, mid-task
  questions, and transcript restore on reload.
- **Milkdown editor** — WYSIWYG markdown with Yjs real-time collaboration and a `/cite` slash
  command that inserts grounded references.
- **One-click project seeding** — a deterministic pipeline runs a PM interview → parallel
  research (Research Assistant + Advisor) → Writer skeleton draft.
- **Live preview & export** — PDF preview pane (markdown → Typst → PDF with citeproc citations)
  plus one-click docx/LaTeX export, all sandboxed.
- **Tenant-safe by design** — project-scoped storage, sandboxed execution, and per-tenant
  knowledge bases over a shared curated guidance corpus.

## Quick Start

### Prerequisites

- Node.js 18+ — **use an LTS release** (e.g. 24). Node 26 currently fails to build the native
  `better-sqlite3` dependency.
- Docker (for sandboxed rendering/export only — the database is in-process SQLite).
- An `ANTHROPIC_API_KEY` (or Claude Code login credentials on a dev machine).

### Run it (one command)

From the repo root:

```bash
# Install everything (root orchestrator + both packages) — first time
npm install

# Configure backend credentials (first time)
cp agent-backend/.env.example agent-backend/.env   # then set ANTHROPIC_API_KEY

# Start backend (:3002) and webapp (:5174) together — Ctrl-C stops both
npm run dev
```

The root `package.json` is a dev-only orchestrator: its `postinstall` installs both packages,
so a single root `npm install` bootstraps the whole repo.

Then open **http://localhost:5174**. On first run with an empty database, Kuhn creates a
"Demo Manuscript" project — click **Seed project** to run the full seeding pipeline (PM
interview → research → skeleton draft). Note that agent runs use real model quota.

The backend serves at **http://localhost:3002** (health check: `/health`). It creates the
SQLite DB on startup, applies the schema, and seeds agents, tools, and assignments — no
service to start. The DB and uploaded project files live under `KUHN_DATA_DIR` (default:
repo-root `./data`) — `data/db/kuhn.sqlite` and `data/files/<projectId>/`.

### Running the packages individually

Each package is independently installable and runnable; the root command above just wraps them.

```bash
# Backend — http://localhost:3002
cd agent-backend
cp .env.example .env      # first time; set ANTHROPIC_API_KEY
npm install               # first time
npm run dev

# Webapp — http://localhost:5174 (pinned; backend CORS allowlist includes it)
cd webapp
npm install               # first time
npm run dev               # backend must be running
```

See [webapp/README.md](webapp/README.md) for webapp-specific notes.

## Development

### Additional prerequisites

- Typst + Pandoc sandbox images for rendering/export (one-time:
  `docker pull ghcr.io/typst/typst:latest && docker pull pandoc/core:latest`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

Render/export and any future analyst code execution run inside sandboxed Docker images (no host
Python environment required). Re-seed agents/tools after editing prompts or seed data with
`npm run db:seed` (from `agent-backend/`).

See [CLAUDE.md](CLAUDE.md) for detailed contributor guidance (repository layout, where things
live, agent prompts, conventions). This repo is also configured so Claude Code can run common
read-only and build commands without asking permission.

### Architecture

```
┌──────────────────────────────────────────────────┐
│                Browser (single app)               │
│  ┌───────────┐  ┌────────────────┐  ┌─────────┐  │
│  │ Agent     │  │ Milkdown       │  │ File    │  │
│  │ Chat      │  │ Editor (md)    │  │ Manager │  │
│  └─────┬─────┘  └───────┬────────┘  └────┬────┘  │
└────────┼────────────────┼────────────────┼───────┘
         │        WebSocket / REST         │
┌────────▼────────────────▼────────────────▼───────┐
│              Agent Backend (Node.js)              │
│  ┌─────────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Agent       │ │ Storage  │ │ Render/Export │  │
│  │ Runtime     │ │ API      │ │ (Typst,       │  │
│  │ (Claude     │ │ (project │ │  Pandoc,      │  │
│  │  Agent SDK) │ │  scoped) │ │  sandboxed)   │  │
│  └─────────────┘ └──────────┘ └───────────────┘  │
│           SQLite (file) · Yjs servers             │
└───────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for details and the 2026-06-11 decision
revisions (Milkdown editor, Claude Agent SDK, multi-tenancy invariants).

### Agents

The six agents' system prompts live in
[`agent-backend/src/db/prompts/`](agent-backend/src/db/prompts/) and their models/tools in
`agent-backend/src/db/seed-data.js`; both are seeded into the database at startup, and the
runtime loads prompts from there.

### Roadmap

Planned work not yet implemented:

- **More slash commands** — `/write` (contextual drafting), `/research`, `/figure`, `/review`
- **File manager UI** — dedicated file-tree management in the webapp
- **UI design implementation** — the visual design pass
- **Live seeding verification** — end-to-end validation of the seeding pipeline

Work is organized into epics and stories in [`docs/epics/`](docs/epics/).

| Epic | Status | Description |
|------|--------|-------------|
| [001 — Editor Foundation Research](docs/epics/001-editor-foundation-research/index.md) | Done (decision revised 2026-06-11) | Editor evaluation; TeXlyre choice superseded by Milkdown |
| [002 — Agent Orchestration Layer](docs/epics/002-agent-orchestration-layer/index.md) | In Progress | Agent runtime (Claude Agent SDK), single-app webapp, editor integration |
| [003 — TeXlyre Citation Assistant](docs/epics/003-texlyre-citation-assistant/index.md) | Done | Grounded `/cite` workflow — backend logic ported to Milkdown |

## License

TBD — no copyleft constraints; the editor stack (Milkdown/ProseMirror/Yjs) is MIT. See
[strategy.md](strategy.md).
