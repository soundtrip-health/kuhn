# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kuhn is a multi-agent scientific and technical writing framework built on Claude Code. Six specialized AI agents collaborate under human oversight to produce rigorous, citation-grounded documents with iterative review and data analysis.

**Supported project types:**
- FDA Real-World Evidence (RWE) study protocols
- FDA Randomized Clinical Trial (RCT) protocols
- Scientific grant applications (NIH, SBIR, and bespoke)
- Scientific manuscripts (journal articles, conference papers)
- Standard Operating Procedure (SOP) documents

**To start a new project, talk to the Project Manager (PM).** The PM interviews you about your project type, scope, and deliverables, then configures the agents accordingly. Do not use `/init` — the PM creates the project CLAUDE.md to ensure the agents are properly briefed from the start.

## Six-Agent Architecture

The repository uses six agent workspaces, each with its own CLAUDE.md containing detailed conventions. A human Principal Investigator (PI) is the final authority on all consequential scientific, regulatory, and design decisions.

| Agent | Workspace | Role |
|-------|-----------|------|
| **Writer** | `writer/` | Primary document authoring. Edits go to `draft/edits.md`, merged to `draft/main.md` after review. |
| **Analyst** | `analyst/` | Data analysis, feasibility assessment, and quantitative work supporting the document. |
| **Advisor** | `advisor/` | Domain expert maintaining a structured knowledge base. Reads `guidance/` and answers questions with recommended approach + alternatives. |
| **Research Assistant** | `research/` | Literature search, citation management, and source document summarization. Supports all agents. |
| **Critical Reviewer** | `review/` | Adversarial review for scientific rigor, compliance, internal consistency, and argument quality. |
| **Project Manager** | `pm/` | Coordinates work across all agents and the PI. Manages handoffs, quality gates, and project status. Configures project type at initialization. |

**The contract between agents is markdown.** All handoffs are markdown documents, CSV tables, or figures — agent-friendly, human-readable, and git-trackable.

### Interaction Model

PI works primarily with PM and Writer. Both can spawn subagents:
- **Writer** spawns RA (for citations) and Advisor (for domain questions)
- **PM** spawns RA, Reviewer, and Advisor; coordinates parallel dispatch across all agents
- **Advisor** is consulted but never modifies deliverables directly

### Coordination Flow

```
                    ┌──────────────┐
                    │  Human PI    │
                    │  (approves)  │
                    └──────┬───────┘
                           │
                  ┌────────▼────────┐
                  │ Project Manager │
                  │     (pm/)       │
                  └──┬──┬──┬──┬────┘
         ┌──────────┘  │  │  └──────────┐
         ▼             │  │             ▼
  ┌────────────┐       │  │      ┌────────────┐
  │   Writer   │       │  │      │  Analyst   │
  │  (writer/) │       │  │      │ (analyst/) │
  └──┬─────┬───┘       │  │      └────────────┘
     │     │            │  │
     │     │     ┌──────▼──▼────┐
     │     │     │   Critical   │
     │     │     │   Reviewer   │
     │     │     │  (review/)   │
     │     │     └──────────────┘
     │     │
     │     ▼
     │  ┌──────────────┐
     │  │   Advisor    │
     │  │  (advisor/)  │
     │  │  guidance/   │
     │  └──────────────┘
     │
     ▼
  ┌──────────────┐
  │   Research   │
  │  Assistant   │
  │ (research/)  │
  └──────────────┘
```

## Shared Layers

| Layer | Path | Purpose | Who writes |
|-------|------|---------|------------|
| **Deliverables** | `draft/` | Single source of truth — main.md, edits.md, references.bib, tables/, figures/ | Writer (main.md), Analyst (tables/, figures/), RA (references.bib) |
| **Knowledge base** | `guidance/` | Domain knowledge organized by project type — source documents, structured summaries | Advisor maintains; all agents read |
| **Tools** | `scripts/` | read_sections.py, comments_cli.py, doc_index.py, tests/ | Shared |

## Key Commands

### Document editing (Writer)

```bash
# Show outline
python3 scripts/read_sections.py draft/main.md

# Extract specific sections
python3 scripts/read_sections.py draft/main.md 3.4 4.2

# Split all sections into draft/sections/ for batch editing
python3 scripts/read_sections.py draft/main.md --split

# Reassemble from draft/sections/ back into main.md
python3 scripts/read_sections.py draft/main.md --assemble

# Export all TODOs
python3 scripts/read_sections.py draft/main.md --todos

# Citation audit
python3 scripts/read_sections.py draft/main.md --citations
```

### Analyst pipeline (project-specific)

The analyst pipeline varies by project. For the current RWE study:

```bash
python analyst/src/main.py
Rscript analyst/src/power_analysis.R
```

Requires `.env` in `analyst/` with `POSTGRES_URL` (or `DATABASE_URL`). Optional: `CENSUS_API_KEY`.

### Tests

```bash
source .venv/bin/activate
python3 -m pytest scripts/tests/
```

## Critical Conventions

These conventions apply to **all project types**:

1. **"Do not fill gaps"** — the most important rule. Insert `[TODO: ...]` placeholders instead of guessing. Factual accuracy is paramount in scientific and regulatory writing.

2. **Citations must come from PubMed MCP** (or other authoritative MCP sources) — never recall citations from memory. Use `[Author, Year]` format in-text. Maintain `draft/references.bib` (natbib). Disambiguate with letter suffixes (e.g., `[Smith, 2024a]`).

3. **Section-based editing** — documents that approach or exceed the context window must use `scripts/read_sections.py` for section extraction. Never load `draft/main.md` in full when it's large. Use `--split`/`--assemble` for batch edits.

4. **Writer-only edits to draft/main.md** — no other agent writes to `draft/main.md` directly. Analyst outputs go to `draft/tables/` and `draft/figures/`. RA updates `draft/references.bib`.

5. **Advisor answers recommended-first** — advisor gives a recommended approach, then alternatives with trade-offs. Never modifies deliverables directly.

6. **PI is the final authority** — never allow consequential scientific, regulatory, or design decisions without PI approval.

## Knowledge Base Structure

The advisor's knowledge base in `guidance/` is organized by project type. Each branch contains source documents and structured summaries relevant to that type of work. See `guidance/index.md` for the full map.

```
guidance/
├── index.md              # Master index — entry point for all knowledge
├── rwe-protocol/         # FDA RWE study protocols
├── rct-protocol/         # FDA RCT protocols
├── grant-application/    # NIH, SBIR, and bespoke grants
├── manuscript/           # Scientific manuscripts
├── sop/                  # Standard operating procedures
├── shared/               # Cross-cutting references (statistics, methods)
└── src/                  # Legacy source documents (RWE project)
```

The PI may add source documents at any time. The advisor incorporates them into the appropriate branch and updates the index.

## PM Status Files

The project manager maintains these coordination documents in `pm/`:
- `pm/status.md` — current project phase, open action items by agent, blocking issues
- `pm/decisions.md` — running log of key design decisions with rationale and ownership
- `pm/issues.md` — open questions, data concerns, unresolved reviewer findings

## Environment Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## MCP Servers

The writer and research assistant agents use these MCP servers (configured in `.mcp.json`):
- **PubMed** (`@cyanheads/pubmed-mcp-server`) — citation search and article fetch
- **Google Docs** (`@a-bonus/google-docs-mcp`) — direct document editing
- **bioRxiv** (hosted at `mcp.deepsense.ai`) — preprint literature search
- **ClinicalTrials.gov** — trial search, investigator lookup, endpoint analysis

Additional MCP servers may be configured depending on the project type (e.g., NIH Reporter for grant applications).
