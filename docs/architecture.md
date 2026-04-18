# System Architecture

> **Status:** Active — editor foundation decision finalized 2026-04-17. See [Epic 001](epics/001-editor-foundation-research/index.md).

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

**Decision:** Adopt TeXlyre as the editor foundation under an open-core strategy. See [Epic 001](epics/001-editor-foundation-research/index.md) for the full evaluation and [strategy.md](../strategy.md) for the AGPL commercialization approach.

Foundation:

- **Editor:** TeXlyre fork (AGPL-3.0) — React + TypeScript, CodeMirror 6, Vite
- **Language targets:** LaTeX and Typst (both natively supported)
- **Compilation:** Client-side WASM (SwiftLaTeX for LaTeX, typst.ts for Typst); server-side compilation available as a future option
- **Collaboration:** Yjs + WebRTC/WebSocket for real-time collaborative editing
- **Preview:** PDF/Canvas rendering built into TeXlyre

Why TeXlyre:

- Proven extensibility — `/cite` slash command integrated naturally via CodeMirror 6 extensions and the service layer (Epic 003)
- Native LaTeX + Typst support without retrofitting
- Modern stack and collaboration model close to our product target
- Open-core model keeps proprietary agent intelligence behind a clean API boundary

### Open-Core Boundary Rules

- Keep editor UI, slash-command plumbing, and client integration code in the public AGPL layer.
- Keep proprietary value in separate network services: agents, prompts, orchestration, retrieval, billing, and operations.
- Use explicit API boundaries between editor and backend services.
- Do not share internal modules or source packages across the AGPL editor and proprietary backend.
- Do not hide core editor behavior in private backend code.
- Prefer documented, versioned protocols over editor-specific private hooks.
- Upstream generally useful TeXlyre changes when practical to reduce fork burden.
- Document public/private repo boundaries clearly enough for future compliance and diligence review.

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

1. **LaTeX** → `pdflatex` / `xelatex` / `lualatex` → PDF
2. **Typst** → `typst compile` → PDF

Current architectural intent:

- Prefer **server-side compilation** as the default production path for package completeness, reproducibility, and better control over security/resource limits.
- Preserve a clean adapter boundary so we can add **WASM compilation** later for offline or low-latency modes.
- Treat BusyTeX / SwiftLaTeX as potential implementation inputs, not as the product architecture itself.

## Data Model

- Projects are directories on disk (git-trackable)
- Documents are `.tex` or `.typ` files
- Agent state lives in `agents/` subdirectories
- Bibliography in BibTeX (`.bib`) format
- Figures and tables in `figures/` and `tables/`

## Open Questions

- [x] ~~Final editor foundation sign-off~~ — TeXlyre adopted (2026-04-17)
- [ ] Server-side vs WASM compilation defaults (or hybrid by document/runtime)
- [ ] Authentication and multi-user support
- [ ] File storage: local-first vs cloud-backed
- [x] ~~Real-time collaboration~~ — Yjs + WebRTC/WebSocket via TeXlyre
