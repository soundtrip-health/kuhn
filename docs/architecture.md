# System Architecture

> **Status:** Draft — provisional editor-foundation recommendation recorded on 2026-04-11. Final decision still depends on the extensibility spike in Epic 001.

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

**Provisional recommendation:** build Kuhn's editor from primitives rather than adopt an existing AGPL editor wholesale. See [Epic 001](epics/001-editor-foundation-research/index.md).

Recommended foundation:

- **Editor shell:** CodeMirror 6
- **Preview pane:** custom PDF/document preview integration
- **Language targets:** LaTeX and Typst behind a shared editor/workspace model
- **Compilation adapters:** swappable server-side and WASM backends

Reference implementations we should study but not assume we will adopt directly:

- **TeXlyre** for UX patterns and dual LaTeX/Typst support
- **BusyIDE/BusyTeX** for a permissive, browser-side compilation reference and spike target
- **Overleaf CE** for workflow expectations around LaTeX collaboration and project structure

Why this direction:

- It gives us first-class control over slash commands and agent interactions.
- It avoids AGPL risk in the core product shell.
- It lets us choose compilation architecture independently from editor UX.

Alternative strategy under consideration:

- If Kuhn adopts an open-core model, the editor could instead be a public AGPL fork such as TeXlyre, with proprietary agent services behind a network boundary.
- That is a product and licensing posture decision, not the default engineering recommendation.

### Open-Core Checklist

If Kuhn chooses the TeXlyre/AGPL path, developers should keep this checklist in mind:

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

- [ ] Final editor foundation sign-off after Story 005 spike
- [ ] Server-side vs WASM compilation defaults (or hybrid by document/runtime)
- [ ] Authentication and multi-user support
- [ ] File storage: local-first vs cloud-backed
- [ ] Real-time collaboration (CRDT-based?)
