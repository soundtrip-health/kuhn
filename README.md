# Kuhn

A web-based scientific and technical writing tool with integrated AI assistance.

Kuhn provides a browser-based WYSIWYG markdown editor where AI agents deliver real-time help —
slash commands for inserting grounded references, researching ideas, generating figures with
Python, and more. Documents render to PDF via Typst and export to Word/LaTeX via Pandoc, so
authors work in friendly markdown while the toolchain (and the agents) handle formatting.

## Status

**Working prototype — core loop in place (2026-06-12).** The architecture moved (2026-06-11)
from a TeXlyre/LaTeX foundation to a **Milkdown markdown editor** in a single app, with the
agent runtime built on the **Claude Agent SDK**. Running today:

- **Agent backend** — agent runtime behind the `runAgentTask` boundary, per-agent models,
  durable jobs, full conversation logging, project-root-enforcing storage API, sandboxed
  Typst/Pandoc execution, Yjs servers (stories 009–012, 018, 021)
- **Webapp** — agent chat (token streaming, mid-task questions, transcript restore on
  reload), Milkdown editor with real-time collab and `/cite` slash command, file tree
  (stories 013, 016, 020)
- **Project seeding** — one click runs PM interview → RA + Advisor research in parallel →
  Writer skeleton draft, as a deterministic pipeline (story 015)
- **Render & export** — PDF preview pane (markdown → Typst → PDF with citeproc citations,
  sandboxed) and one-click docx/LaTeX export (story 019)

The TeXlyre fork (Epic 003's `/cite` reference) was removed after the port landed
(stories 016, 023; git history preserves it). Next up: `/write` (017), file manager (014),
UI design implementation (025). Live seeding verification (022) is deferred while the
prototype is tested hands-on.

## Goals

- **Markdown-first** — canonical authoring format is markdown with BibTeX; Typst renders PDF,
  Pandoc exports docx/LaTeX. LaTeX is an export target, not a prerequisite.
- **Agent-integrated editing** — six specialized AI agents (writer, analyst, advisor, research,
  review, PM) embedded in the editing experience
- **Slash commands** — `/cite` to insert a grounded reference, `/write` for contextual drafting,
  `/research`, `/figure`, `/review`
- **Live preview** — rendered document preview as you write
- **Collaboration-ready** — Yjs-based real-time editing for teams working on manuscripts,
  protocols, and grant applications
- **Tenant-safe by design** — project-scoped storage, sandboxed execution, per-tenant knowledge
  bases with a shared curated guidance corpus

## Architecture

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
│        Postgres + pgvector · Yjs servers          │
└───────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for details and the 2026-06-11 decision
revisions (Milkdown, Claude Agent SDK, multi-tenancy invariants).

## Project Management

Work is organized into epics and stories in [`docs/epics/`](docs/epics/).

| Epic | Status | Description |
|------|--------|-------------|
| [001 — Editor Foundation Research](docs/epics/001-editor-foundation-research/index.md) | Done (decision revised 2026-06-11) | Editor evaluation; TeXlyre choice superseded by Milkdown |
| [002 — Agent Orchestration Layer](docs/epics/002-agent-orchestration-layer/index.md) | In Progress | Agent runtime (Claude Agent SDK), single-app webapp, editor integration |
| [003 — TeXlyre Citation Assistant](docs/epics/003-texlyre-citation-assistant/index.md) | Done | Grounded `/cite` workflow — backend logic ports to Milkdown (story 016) |

## Agents

The `agents/` directory contains the AI agent framework — six specialized agents that power the
writing assistance. See [agents/README.md](agents/README.md) for details.

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for Postgres and sandboxed rendering)

### Agent Backend

```bash
cd agent-backend

# Start Postgres (first time or after reboot)
docker compose up -d

# Install deps (first time)
npm install

# Start the backend
npm run dev
```

Starts at **http://localhost:3002**. On startup it creates the database schema and seeds agent
prompts from `agents/*/AGENTS.md`. Health check: http://localhost:3002/health

Re-seed after editing AGENTS.md files: `npm run db:seed`

### Webapp

```bash
cd webapp

# Install deps (first time)
npm install

# Start the dev server (backend must be running)
npm run dev
```

Opens at **http://localhost:5174** (pinned; the backend CORS allowlist includes it). On first
run with an empty database it creates a "Demo Manuscript" project. Use the **Seed project**
button to run the full seeding pipeline (PM interview → research → skeleton draft) — note that
agent runs use real model quota. See [webapp/README.md](webapp/README.md).

## Development

### Additional Prerequisites

- Python 3.11+ (for agent scripts and figure generation)
- Typst + Pandoc sandbox images for rendering/export (one-time:
  `docker pull ghcr.io/typst/typst:latest && docker pull pandoc/core:latest`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

### Agent Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r agents/requirements.txt
```

### Working with Claude Code

This repo is configured so Claude Code can run common read-only and build commands without
asking permission. See the "Working with Claude Code" section in [CLAUDE.md](CLAUDE.md).

## License

TBD — no copyleft constraints; the editor stack (Milkdown/ProseMirror/Yjs) is MIT. See
[strategy.md](strategy.md).
