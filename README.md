# Kuhn

A web-based scientific and technical writing tool with integrated AI assistance.

Kuhn provides a browser-based LaTeX/Typst editor where AI agents deliver real-time help — slash commands for inserting references, researching ideas, generating figures with Python, and more. A built-in terminal gives CLI access for power users, but most workflows happen in the editor.

## Status

**Early stage.** Editor-foundation research is complete enough to start implementation work on the TeXlyre path. Current execution is centered on [Epic 003](docs/epics/003-texlyre-citation-assistant/index.md), which bootstraps the vendored `texlyre/` fork and builds the first `/cite` assistant workflow.

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
| [002 — Agent Orchestration Layer](docs/epics/002-agent-orchestration-layer/index.md) | Draft | Choose or build the runtime layer for agent dispatch, streaming, and tool use |
| [003 — TeXlyre Citation Assistant](docs/epics/003-texlyre-citation-assistant/index.md) | In Progress | Bring up the TeXlyre fork and implement the first grounded `/cite` editor workflow |

## Agents

The `agents/` directory contains the AI agent framework — six specialized agents that power the writing assistance. See [agents/README.md](agents/README.md) for details.

## Development

### Prerequisites

- Node.js 24.13.1+ for `texlyre/` work; see [Epic 003 bootstrap notes](docs/epics/003-texlyre-citation-assistant/bootstrap-notes.md)
- Python 3.11+ (for agent scripts and figure generation)
- A LaTeX distribution (TeX Live or TinyTeX) and/or Typst
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

### Getting started

```bash
git clone <repo-url> kuhn
cd kuhn

# Agent dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r agents/requirements.txt

# Webapp dependencies (TBD)
# npm install
# npm run dev
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
