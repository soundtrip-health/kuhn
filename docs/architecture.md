# System Architecture

> **Status:** Draft — the editor foundation has not been chosen yet. This document captures the target architecture and will be updated as decisions are made.

## Overview

Kuhn is a web application with three main subsystems:

1. **Editor** — a browser-based LaTeX/Typst editor with syntax highlighting, autocompletion, and live preview
2. **Agent layer** — six AI agents providing real-time writing assistance via slash commands and a sidebar
3. **Terminal** — an embedded terminal for CLI access to the agents and system tools

## High-Level Components

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (Browser)                  │
│                                                        │
│  ┌────────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Editor Pane   │  │ Agent Panel  │  │ Terminal   │  │
│  │  - CodeMirror  │  │ - Chat UI    │  │ - xterm.js │  │
│  │    or Monaco   │  │ - /commands  │  │ - PTY      │  │
│  │  - LaTeX mode  │  │ - Results    │  │            │  │
│  │  - Typst mode  │  │              │  │            │  │
│  └───────┬────────┘  └──────┬───────┘  └─────┬─────┘  │
│          │                  │                 │        │
│  ┌───────▼──────────────────▼─────────────────▼─────┐  │
│  │              WebSocket / REST API                 │  │
│  └──────────────────────┬────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────┐
│                     Backend (Node.js)                      │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │  Compiler    │  │ Agent Router │  │ Terminal Svc   │   │
│  │  Service     │  │              │  │                │   │
│  │  - pdflatex  │  │ - Dispatch   │  │ - PTY mgmt    │   │
│  │  - typst     │  │ - Streaming  │  │ - Session mgmt│   │
│  │  - SyncTeX   │  │ - /cmd parse │  │               │   │
│  └──────────────┘  └──────┬───────┘  └────────────────┘   │
│                           │                                │
│                  ┌────────▼────────┐                       │
│                  │  Agent Runtime  │                       │
│                  │  (Claude Code)  │                       │
│                  │                 │                       │
│                  │  writer/        │                       │
│                  │  analyst/       │                       │
│                  │  advisor/       │                       │
│                  │  research/      │                       │
│                  │  review/        │                       │
│                  │  pm/            │                       │
│                  └─────────────────┘                       │
└────────────────────────────────────────────────────────────┘
```

## Editor Foundation

**Decision pending.** See [Epic 001](epics/001-editor-foundation-research/index.md).

Candidates under evaluation:
- **TeXlyre** — feature-rich, but AGPL-licensed (restrictive for SaaS)
- **BusyIDE/BusyTeX** — MIT-licensed, WASM-based TeX compilation in browser
- **Build from components** — CodeMirror 6 + custom LaTeX/Typst language support

Key requirements:
- Browser-based editing with syntax highlighting
- LaTeX and Typst compilation (server-side or WASM)
- SyncTeX-style source ↔ preview navigation
- Extensible for slash commands and agent integration
- License compatible with our distribution model

## Slash Commands

The editor will support `/commands` that invoke agents inline:

| Command | Agent | Action |
|---------|-------|--------|
| `/cite <query>` | Research | Search PubMed/bioRxiv, insert citation |
| `/research <question>` | Research | Quick literature lookup, return summary |
| `/figure <description>` | Analyst | Generate a figure via Python, insert it |
| `/review` | Reviewer | Critique the current section |
| `/ask <question>` | Advisor | Domain expertise question |
| `/status` | PM | Project status summary |

## Compilation Pipeline

Two compilation targets:

1. **LaTeX** → pdflatex/xelatex/lualatex → PDF
2. **Typst** → typst compile → PDF

Compilation can run server-side (preferred for consistency) or client-side via WASM (for offline/low-latency use). The architecture should support both.

## Data Model

- Projects are directories on disk (git-trackable)
- Documents are `.tex` or `.typ` files
- Agent state lives in `agents/` subdirectories
- Bibliography in BibTeX (`.bib`) format
- Figures and tables in `figures/` and `tables/`

## Open Questions

- [ ] Editor foundation choice (Epic 001)
- [ ] Server-side vs WASM compilation (or hybrid)
- [ ] Authentication and multi-user support
- [ ] File storage: local-first vs cloud-backed
- [ ] Real-time collaboration (CRDT-based?)
