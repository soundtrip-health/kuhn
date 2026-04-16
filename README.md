# Kuhn

A web-based scientific and technical writing tool with integrated AI assistance.

Kuhn provides a browser-based LaTeX/Typst editor where AI agents deliver real-time help — slash commands for inserting references, researching ideas, generating figures with Python, and more. A built-in terminal gives CLI access for power users, but most workflows happen in the editor.

## Status

**Early stage.** The TeXlyre editor fork is running with a working `/cite` command (Epic 003 complete). The agent backend has a Postgres schema, seeded agent prompts, and Yjs signaling (Epic 002 in progress). Next up: agent routing and the chat workspace.

## Goals

- **LaTeX-first, Typst-supported** — standardize on LaTeX with first-class Typst support
- **Agent-integrated editing** — six specialized AI agents (writer, analyst, advisor, research, review, PM) embedded in the editing experience
- **Slash commands** — `/cite` to insert a reference, `/research` to investigate an idea, `/figure` to generate a plot, `/review` to get a critique
- **Real-time compilation** — live preview of the compiled document as you type
- **Built-in terminal** — full CLI access for advanced workflows and direct agent interaction
- **Collaboration-ready** — designed for teams working on scientific manuscripts, protocols, and grant applications

## Architecture

```
┌─────────────────────────────────────────────┐
│              Browser (webapp)                │
│  ┌─────────────┐  ┌──────────┐  ┌────────┐  │
│  │ LaTeX/Typst │  │  Agent   │  │Terminal│  │
│  │   Editor    │  │ Sidebar  │  │  Panel │  │
│  └──────┬──────┘  └────┬─────┘  └───┬────┘  │
│         │              │             │       │
└─────────┼──────────────┼─────────────┼───────┘
          │              │             │
┌─────────▼──────────────▼─────────────▼───────┐
│                  Backend                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Compiler │  │  Agent   │  │  Terminal   │  │
│  │  Service │  │  Router  │  │  Service    │  │
│  └──────────┘  └──────────┘  └────────────┘  │
└───────────────────────┬──────────────────────┘
                        │
              ┌─────────▼─────────┐
              │   agents/         │
              │  (Claude Code)    │
              └───────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for details.

## Project Management

Work is organized into epics and stories in [`docs/epics/`](docs/epics/).

| Epic | Status | Description |
|------|--------|-------------|
| [001 — Editor Foundation Research](docs/epics/001-editor-foundation-research/index.md) | In Progress | Evaluate open-source editor options (TeXlyre, BusyIDE, etc.) |
| [002 — Agent Orchestration Layer](docs/epics/002-agent-orchestration-layer/index.md) | In Progress | Agent backend, workspace, and writer integration |
| [003 — TeXlyre Citation Assistant](docs/epics/003-texlyre-citation-assistant/index.md) | Done | TeXlyre fork with grounded `/cite` editor workflow |

## Agents

The `agents/` directory contains the AI agent framework — six specialized agents that power the writing assistance. See [agents/README.md](agents/README.md) for details.

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for Postgres)

### 1. TeXlyre Editor

```bash
cd texlyre
npm install
npm run dev
```

Opens at **http://localhost:5173/texlyre/**

### 2. Agent Backend

```bash
cd agent-backend

# Start Postgres (first time or after reboot)
docker compose up -d

# Install deps (first time)
npm install

# Start the backend
npm run dev
```

Starts at **http://localhost:3002**. On startup it automatically creates the database schema and seeds agent prompts from `agents/*/AGENTS.md`.

Health check: http://localhost:3002/health

### 3. Re-seed the database

If you edit AGENTS.md files and want to update prompts without restarting:

```bash
cd agent-backend
npm run db:seed
```

### Useful Commands

| Command | Where | What |
|---------|-------|------|
| `npm run dev` | `texlyre/` | Start editor dev server (port 5173) |
| `npm run dev` | `agent-backend/` | Start backend dev server (port 3002) |
| `docker compose up -d` | `agent-backend/` | Start Postgres |
| `docker compose down` | `agent-backend/` | Stop Postgres |
| `npm run db:seed` | `agent-backend/` | Re-seed agents and tools |
| `npm test` | `texlyre/` | Run editor test suite |

## Development

### Additional Prerequisites

- Python 3.11+ (for agent scripts and figure generation)
- A LaTeX distribution (TeX Live or TinyTeX) and/or Typst
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

### Agent Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r agents/requirements.txt
```

### Working with Claude Code

This repo is configured so Claude Code can run common read-only and build commands without asking permission. See the "Working with Claude Code" section in [CLAUDE.md](CLAUDE.md) for details on:

- Configuring `.claude/settings.json` for autonomous operation
- User-level vs project-level permission settings
- Tips for effective usage

To go fully autonomous (use with care):

```
/permissions
→ select "full-auto"
```

## License

TBD
