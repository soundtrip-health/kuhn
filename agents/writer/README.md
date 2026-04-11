# Writer Agent Workspace

This directory is the **writer agent** workspace for the Kuhn scientific writing framework. The writer is the primary author — the only agent that edits `draft/main.md`. It adapts to the project type (FDA protocols, grant applications, manuscripts, SOPs) based on PM configuration.

The lessons below were learned during the initial RWE protocol project (comparing IV ketamine vs. esketamine for TRD) and apply broadly to any scientific or technical writing project using this framework. See the [top-level README](../README.md) for the full multi-agent architecture.

## What We Built

**A ~1,750-line study protocol** (`draft.md`) covering:

- Study design and regulatory rationale (FDA RWE framework, three regulatory pillars)
- Population definitions and eligibility criteria aligned with the EQUIV target trial
- Exposure definitions with prespecified treatment-switching thresholds
- Estimand framework (ICH E9(R1)) with primary and secondary estimands
- Statistical methods: propensity score weighting, linear mixed-effects models, multiple imputation
- Non-inferiority margin justification (M1/M2 framework per FDA guidance)
- Power analysis and feasibility assessment
- Effectiveness, safety, and exploratory analyses (including bipolar depression)
- 5 publication-quality mock figures for Appendix B

**Supporting infrastructure:**

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/read_sections.py` | 1,226 | Section parser: outline, extract, TODOs, citation audit |
| `scripts/comments_cli.py` | 298 | Filter and search comment export JSON |
| `scripts/generate_figure_shells.py` | 307 | Generate mock figures with simulated data |
| `scripts/doc_index.py` | 242 | Google Docs character index lookup |
| `CLAUDE.md` | 190 | Agent instructions and project conventions |
| `draft/references.bib` | 997 | BibTeX bibliography with PubMed-sourced citations |

## Lessons Learned: Agentic AI for Scientific Writing

### What Works Well

1. **Context management is the central challenge.** The protocol outgrew the context window early. The `read_sections.py` script became the workhorse — letting the agent work on specific sections without loading the full document. This section-based workflow (outline → extract → edit → save to `edits.md`) was critical to scaling.

2. **CLAUDE.md as institutional memory.** The project instructions file grew to encode regulatory requirements, citation conventions, NI design guardrails, and FDA guidance summaries. This let the agent make informed decisions without re-reading source PDFs every session. Treat CLAUDE.md as the "briefing document" for every new conversation.

3. **MCP servers for external knowledge.** PubMed MCP kept citations grounded in real articles (no hallucinated references). Google Docs MCP enabled direct editing. bioRxiv MCP supported literature search. These integrations eliminated the weakest point of LLM-assisted writing: fabricated sources.

4. **Strict "do not fill gaps" rule.** Scientific protocols require precision. The instruction to insert `[TODO: ...]` placeholders instead of guessing prevented subtle errors that would be hard to catch in review. This is the single most important rule for regulatory/scientific writing with AI.

5. **Tooling compounds.** The section parser started as a simple extractor, then grew features (citation audit, TODO export, outline generation) that accelerated later work. Each feature saved repeated manual scanning of the document.

6. **BibTeX-based citation workflow.** Using `[Author, Year]` in-text citations with a maintained `.bib` file avoided renumbering chaos. The `--citations` flag on the parser made auditing straightforward.

### What Requires Discipline

1. **The agent will always try to be helpful by filling in blanks.** Constant vigilance is needed. The "do not fill gaps" and "factual accuracy is paramount" rules must be explicit and reinforced — the default behavior of LLMs is to complete text plausibly, not accurately.

2. **Session boundaries lose context.** Each new Claude Code conversation starts fresh. Without CLAUDE.md and persistent memory, the agent would re-read guidance documents and re-discover conventions every session. Invest early in the instructions file.

3. **Large documents need structured workflows.** Simply asking "edit section 3" on a 1,750-line markdown file fails. The section-based extraction workflow (parser script + `edits.md` staging) was essential. Plan for this from the start on any document over ~500 lines.

4. **Citation verification is ongoing work.** Even with PubMed MCP, citations need human review — the agent can retrieve real articles but may misattribute claims or select marginally relevant references. The citation audit CSV helps, but domain expertise is required.

5. **Regulatory nuance needs source-grounding.** FDA guidance documents have specific line-number-level requirements. Summarizing these in CLAUDE.md (with section/line references back to source PDFs) let the agent apply them correctly. Vague instructions produce vague compliance.

## Project Architecture

```
protocol/
├── CLAUDE.md                    # Writer agent instructions and regulatory guardrails
├── protocol_guide.md            # Entry point linking all reference documents
├── feasibility_analysis_spec.md # Analysis spec handed to the analyst agent
├── draft/                       # Working documents and outputs
│   ├── references.bib           # PubMed-sourced BibTeX bibliography
│   ├── margin_calculation.md    # NI margin derivation notes
│   └── figures/                 # Generated mock figures (PNG + Mermaid)
├── scripts/                     # Helper scripts
│   ├── read_sections.py         # Section parser (outline, extract, TODOs, citations)
│   ├── comments_cli.py          # Comment filtering CLI
│   ├── generate_figure_shells.py # Mock figure generator
│   ├── doc_index.py             # Google Docs index utility
│   ├── auth.sh                  # OAuth flow setup
│   ├── get_doc.sh               # Google Docs retrieval utility
│   ├── test_read_sections.py    # Unit tests for section parser
│   └── test_comments_cli.py     # Unit tests for comment CLI
├── src/                         # FDA guidance PDFs and reference documents
│   ├── framework.pdf            # FDA RWE Program Framework
│   ├── assessing.pdf            # FDA EHR/claims data guidance
│   ├── considerations.pdf       # FDA non-interventional study guidance
│   ├── non-inferior-guidance.pdf # FDA NI trial design guidance
│   ├── tte_design_2026.pdf      # Target Trial Emulation review
│   ├── EQUIV.pdf                # EQUIV protocol (target trial)
│   ├── sap_draft.md             # Draft Statistical Analysis Plan
│   └── litreview/               # Published trial papers and FDA guidance
│       └── Major-Depressive-Disorder-...  # FDA MDD drug development guidance
└── README.md
```

**Generated during active use** (not in repo):
- `draft/draft.md` — primary protocol document (~1,750 lines), the main working document
- `draft/edits.md` — staging area for section updates (protects draft.md from accidental overwrites)
- `.mcp.json` — MCP server configuration with credentials (see setup below)

## Prerequisites

- Python 3.10+ (for helper scripts)
- [Node.js](https://nodejs.org/) v18+ (for MCP servers via `npx`)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## MCP Server Setup

Three MCP servers power the writer agent. Create a `.mcp.json` in this directory with the following configuration:

### Google Docs MCP

Reading and editing Google Docs directly from Claude Code.

**Package:** [`@a-bonus/google-docs-mcp`](https://github.com/a-bonus/google-docs-mcp)

```json
{
  "google-docs": {
    "command": "npx",
    "args": ["-y", "@a-bonus/google-docs-mcp"],
    "env": {
      "GOOGLE_CLIENT_ID": "<YOUR_GOOGLE_CLIENT_ID>",
      "GOOGLE_CLIENT_SECRET": "<YOUR_GOOGLE_CLIENT_SECRET>"
    }
  }
}
```

To obtain credentials: create a project in the [Google Cloud Console](https://console.cloud.google.com/), enable Google Docs and Drive APIs, create OAuth 2.0 client credentials (Desktop app type), then run the auth flow:

```bash
source auth.sh  # or run the OAuth flow manually
```

### PubMed MCP

Citation search, article fetch, and MeSH lookup via NCBI E-utilities.

**Package:** [`@cyanheads/pubmed-mcp-server`](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server)

```json
{
  "pubmed": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@cyanheads/pubmed-mcp-server@latest"],
    "env": {
      "NCBI_API_KEY": "<YOUR_NCBI_API_KEY>"
    }
  }
}
```

Free API key: <https://www.ncbi.nlm.nih.gov/account/settings/>

### bioRxiv MCP

Preprint search on bioRxiv/medRxiv. Hosted — no API key needed.

```json
{
  "biorxiv": {
    "type": "http",
    "url": "https://mcp.deepsense.ai/biorxiv/mcp"
  }
}
```

## Helper Scripts

### `scripts/read_sections.py` — the workhorse

```bash
# Full outline
python3 scripts/read_sections.py draft/draft.md

# Extract specific sections
python3 scripts/read_sections.py draft/draft.md 3.4 4.2

# Outline + write TOC file
python3 scripts/read_sections.py draft/draft.md --outline

# Export all TODOs
python3 scripts/read_sections.py draft/draft.md --todos

# Citation audit (CSV + bibliography)
python3 scripts/read_sections.py draft/draft.md --citations
```

### `scripts/comments_cli.py`

```bash
# Filter comment JSON exports
python3 scripts/comments_cli.py draft-comments.json --search "margin"
```

### `scripts/generate_figure_shells.py`

```bash
# Generate all Appendix B mock figures
python3 scripts/generate_figure_shells.py
```

## Getting Started

1. Clone the parent repo and `cd protocol/`
2. Create `.mcp.json` with MCP server credentials (see above)
3. Run the Google Docs OAuth flow if using the Docs MCP (`source scripts/auth.sh`)
4. Launch Claude Code: `claude`
5. The agent reads CLAUDE.md for project conventions and uses MCP servers for external data
6. To start a new protocol, create `draft/draft.md` — the agent will work on specific sections using `scripts/read_sections.py`

## Key Design Decisions

- **Section-based editing**: Never load the full protocol into context. Use `scripts/read_sections.py` to extract, edit in `draft/edits.md`, then merge.
- **No gap-filling**: Placeholders (`[TODO: ...]`) instead of plausible guesses. Accuracy over completeness.
- **PubMed-only citations**: Every reference must be retrievable via PubMed MCP. No citations from memory.
- **`[Author, Year]` format**: Avoids numbered-reference renumbering issues across edits.
- **`draft/edits.md` staging**: Protects the primary document from accidental overwrites during iterative editing.
