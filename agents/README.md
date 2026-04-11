# Kuhn — Multi-Agent Scientific & Technical Writing Framework

A multi-agent AI workflow for producing rigorous, citation-grounded scientific and technical documents. Six specialized agents collaborate under human PI oversight: a **writer** drafts the document, an **analyst** runs quantitative analyses, an **advisor** provides domain expertise from a structured knowledge base, a **research assistant** manages literature and citations, a **critical reviewer** checks rigor and consistency, and a **project manager** coordinates handoffs and quality gates. All handoffs are markdown — agent-friendly, human-readable, and git-trackable.

## Supported Project Types

| Type | Writer Focus | Analyst Focus | Example Guidance |
|------|-------------|---------------|------------------|
| **FDA RWE Protocol** | Regulatory compliance, study design, estimand framework | EHR data, propensity methods, power analysis | FDA guidance, NI design |
| **FDA RCT Protocol** | Regulatory compliance, trial design, randomization | Sample size, interim analyses, adaptive designs | ICH guidelines, FDA guidance |
| **Grant Application** | Aims, significance, innovation, approach | Preliminary data, power analysis, feasibility | NIH/SBIR guidelines, funder RFAs |
| **Scientific Manuscript** | Journal conventions, narrative structure, methods | Results, figures, statistical reporting | Target journal guidelines |
| **SOP Document** | Process clarity, compliance requirements, step-by-step procedures | Validation data, process metrics | Regulatory standards, ISO/GxP |

The framework adapts to each project type while sharing core infrastructure: PubMed-grounded citations, `[TODO: ...]` placeholders, section-based editing, markdown handoffs, and adversarial review.

## Getting Started

### 1. Set up the environment

```bash
git clone <repo-url> && cd kuhn
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Talk to the Project Manager

**Start every new project by launching the PM agent.** The PM will interview you about your project — what type of document you're writing, what your goals are, what source materials you have — and configure the agents accordingly.

```bash
cd pm
claude
```

Tell the PM what you're working on. For example:
- *"I'm writing an RWE protocol comparing two treatments for TRD using EHR data."*
- *"I need to write an R01 grant application for an fMRI study of depression."*
- *"I'm drafting a manuscript on our ketamine real-world evidence results."*
- *"We need an SOP for our clinical data pipeline."*

The PM will:
1. Interview you to define scope, deliverables, and timeline
2. Configure the project CLAUDE.md with project-type-specific guidance
3. Task the RA to find relevant source documents
4. Task the advisor to build the knowledge base from those sources
5. Set up `pm/status.md` to track progress

**Do not use `/init`** — the PM creates the project configuration to ensure agents are properly briefed from the start.

### 3. Work with the agents

Once the PM has set up the project, you can work directly with individual agents:

```bash
# Work with the writer on the primary document
cd writer && claude

# Work with the analyst on data analysis
cd analyst && claude

# Consult the advisor on domain questions
cd advisor && claude

# Task the research assistant with literature search
cd research && claude

# Request a critical review
cd review && claude
```

Each agent workspace has its own CLAUDE.md with role-specific instructions. The PM coordinates work across agents, but you can also interact with agents directly.

## Repository Structure

```
kuhn/
├── draft/                    # Single source of truth — all deliverables
│   ├── main.md               # Primary document (writer-only edits)
│   ├── edits.md              # Writer staging area
│   ├── references.bib        # Shared bibliography (RA maintains)
│   ├── tables/               # Analyst outputs (CSV/md)
│   └── figures/              # All figures
├── guidance/                 # Advisor's knowledge base (branched by project type)
│   ├── index.md              # Master index — entry point
│   ├── rwe-protocol/         # FDA RWE protocol knowledge
│   ├── rct-protocol/         # FDA RCT protocol knowledge
│   ├── grant-application/    # Grant application knowledge
│   ├── manuscript/           # Scientific manuscript knowledge
│   ├── sop/                  # SOP knowledge
│   ├── shared/               # Cross-cutting references
│   └── src/                  # Source documents (current project)
├── scripts/                  # Shared tools
│   ├── read_sections.py      # Section parser (outline, extract, split, assemble, TODOs, citations)
│   ├── comments_cli.py       # Comment filtering CLI
│   ├── doc_index.py          # Google Docs index utility
│   └── tests/
├── writer/                   # Writer agent workspace
├── analyst/                  # Analyst agent workspace
├── advisor/                  # Advisor agent workspace
├── research/                 # Research assistant workspace
├── review/                   # Reviewer agent workspace
├── pm/                       # Project manager workspace
├── CLAUDE.md                 # Root architecture overview
├── requirements.txt          # Python dependencies
└── README.md
```

## The Six-Agent Workflow

### Writer Agent (writer/)

The writer is the primary author — it makes scientific and design decisions, grounded in the advisor's knowledge base and the research assistant's citations. It is the **only agent that edits `draft/main.md`**.

**Adapts to project type:**
- For FDA protocols: regulatory design decisions, estimand framework, compliance language
- For grant applications: specific aims, significance/innovation framing, approach narrative
- For manuscripts: journal-appropriate structure, methods precision, results narrative
- For SOPs: step-by-step procedures, compliance language, validation criteria

**Key tools:** `scripts/read_sections.py` for section-based editing, PubMed MCP for grounded citations.

### Analyst Agent (analyst/)

The analyst handles all quantitative work — receiving specs from the writer and returning results as tables, figures, and markdown reports.

**Adapts to project type:**
- For protocols: cohort enumeration, feasibility, power analysis
- For grant applications: preliminary data analysis, sample size justification
- For manuscripts: statistical analysis, figure generation, results tables
- For SOPs: process metrics, validation data

### Advisor Agent (advisor/)

The advisor maintains a structured knowledge base in `guidance/` and fields focused questions from other agents. It provides domain expertise with a recommended approach plus alternatives and trade-offs. It does not modify deliverables directly.

**Knowledge base branches by project type** — the advisor grows wiser over time as source documents accumulate across projects. See `guidance/index.md` for the current knowledge map.

### Research Assistant (research/)

The RA finds, retrieves, organizes, and summarizes source material. It uses PubMed MCP, bioRxiv MCP, and ClinicalTrials.gov MCP for grounded searches. It does not interpret or make design decisions.

### Critical Scientific Reviewer (review/)

The reviewer is deliberately adversarial — it finds problems before external reviewers do. It adapts its review criteria to the project type (regulatory compliance for FDA protocols, study section expectations for grants, journal reviewer concerns for manuscripts).

### Project Manager (pm/)

The PM is the coordination hub. It configures the project, manages handoffs, runs quality gates, and tracks status so the PI can focus on consequential decisions.

### The Coordination Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Human PI                                        │
│                      (final authority)                                   │
│                            │                                             │
│                    ┌───────▼────────┐                                    │
│                    │ Project Manager│◄──── status.md, decisions.md,      │
│                    │    (pm/)       │      issues.md                     │
│                    └──┬──┬──┬──┬───┘                                    │
│           ┌───────────┘  │  │  └───────────┐                            │
│           ▼              │  │              ▼                             │
│   ┌──────────────┐       │  │      ┌──────────────┐                     │
│   │    Writer    │       │  │      │   Analyst    │                     │
│   │  (writer/)   │       │  │      │  (analyst/)  │                     │
│   │              │ analysis  │     │              │                     │
│   │ Knowledge-   │──spec───┼──────▶│ Data sources │                     │
│   │ grounded     │         │       │ Analysis     │                     │
│   │ authoring    │◀─results┼───────│ pipeline     │                     │
│   └──┬───┬───────┘  report │       └──────────────┘                     │
│      │   │              │  │                                             │
│      │   │       ┌──────▼──▼────┐                                       │
│      │   │       │   Critical   │                                       │
│      │   │       │   Reviewer   │                                       │
│      │   │       │  (review/)   │                                       │
│      │   │       └──────────────┘                                       │
│      │   │                                                               │
│      │   ▼                                                               │
│      │  ┌──────────────┐                                                │
│      │  │   Advisor    │                                                │
│      │  │  (advisor/)  │                                                │
│      │  │  guidance/   │                                                │
│      │  └──────────────┘                                                │
│      │                                                                   │
│      ▼                                                                   │
│  ┌──────────────┐                                                       │
│  │   Research   │                                                       │
│  │  Assistant   │                                                       │
│  │ (research/)  │                                                       │
│  └──────────────┘                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

## Lessons Learned

See [`writer/README.md`](writer/README.md) for detailed lessons from the initial RWE protocol project.

### What Works

1. **"Do not fill gaps" is the single most important rule.** LLMs default to completing text plausibly, not accurately. For scientific and regulatory writing, insert `[TODO: ...]` placeholders instead of guessing.

2. **CLAUDE.md as institutional memory.** Encode domain requirements, citation conventions, and design guardrails with specific references back to source documents. This is the briefing document for every new conversation.

3. **MCP servers eliminate hallucinated citations.** PubMed MCP grounds every reference in a real, retrievable article.

4. **Section-based editing scales.** Documents over ~500 lines need structured workflows: extract specific sections, edit, reassemble. The `read_sections.py` parser is the workhorse tool.

5. **Splitting writer and analyst preserves context focus.** The writer needs deep domain context. The analyst needs deep data/code context. Keeping them separate lets each agent work within its context window effectively.

6. **Markdown is the ideal interchange format.** Agent-friendly, human-readable, git-trackable.

### What Requires Discipline

1. **Human-in-the-loop is essential for QC.** Plausibility checks on analyst output — before they propagate to the writer — are critical.

2. **Session boundaries lose context.** Invest early in CLAUDE.md and persistent memory.

3. **Citation verification is ongoing.** Even with PubMed MCP, citations need human review.

4. **Domain nuance needs source-grounding.** Summarize key requirements in CLAUDE.md with specific section/page references back to source documents.

## Prerequisites

- Python 3.10+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- `requirements.txt` dependencies installed in a virtual environment
- Node.js v18+ (for MCP servers via `npx`)
- Additional dependencies vary by project type (see agent CLAUDE.md files)
