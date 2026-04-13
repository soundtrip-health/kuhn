# Epic 003: TeXlyre Citation Assistant

**Status:** In Progress
**Created:** 2026-04-11

## Goal

Get the `./texlyre` fork running as Kuhn's near-term editor shell, then add the first real editor-native research assistant flow: a `/cite` slash command that suggests grounded citations for the claim in the previous sentence. The initial design should assume a small browser-resident model for low-latency language tasks, while citation lookup and verification rely on authoritative, user-configurable scholarly sources to minimize hallucinated references.

## Context

We already have a local TeXlyre fork in the repo, and it gives us several useful starting points:

- A working browser-based LaTeX/Typst editor with collaboration and preview
- Existing bibliography integrations, including OpenAlex and Zotero
- An embedded Draw.io viewer that can later support `/diagram`
- A plugin-oriented architecture that appears suitable for editor-side extension work

The orchestration layer is still undecided, so this epic should avoid coupling the first assistant workflow to a heavy backend agent runtime. The first milestone is narrower: prove that Kuhn can invoke an editor command, inspect nearby writing context, search configured scholarly sources, rank candidate papers conservatively, and help the user insert a real citation without fabricating metadata.

For on-device intelligence, we want to start by evaluating Qwen 3 1.7B in-browser for lightweight intent parsing, context reading, query generation, and optional result summarization. However, the model must not be treated as a source of truth for bibliography data. `/cite` should only present references that were actually retrieved from configured sources and passed metadata validation.

## Key Decision Factors

- **Grounding rigor** — `/cite` must never invent papers, authors, DOIs, PMIDs, or venues
- **Hint handling** — user-provided clues should improve retrieval without being treated as facts
- **Editor integration** — command flow must feel native inside TeXlyre rather than bolted on
- **Local responsiveness** — simple command understanding should work quickly in-browser
- **Configurable sources** — users should be able to enable, disable, and prioritize citation providers
- **Source quality** — default providers should cover scientific and technical literature well
- **Bibliography insertion** — accepted citations must map cleanly into `.bib` workflows and editor autocomplete
- **Privacy model** — keep local context local when possible and make external lookups explicit
- **Extensibility** — the same foundation should later support `/diagram` and `/search`

## Initial Scope

- Bring up the TeXlyre fork as a working Kuhn development baseline
- Identify extension points for slash-command-style editor actions
- Evaluate an in-browser Qwen 3 1.7B runtime for lightweight assistant tasks
- Design and implement `/cite` first
- Support optional user hints in the command input, such as likely authors, years, venues, or keywords
- Define a provider abstraction for authoritative literature sources
- Start with a configurable default provider set:
  - PubMed
  - arXiv
  - medRxiv
  - bioRxiv
  - PsyArXiv
  - IEEE Xplore
  - OpenAlex

## Non-Goals

- Finalize the full multi-agent orchestration architecture
- Ship `/diagram` or `/search` beyond design and interface scaffolding
- Solve all citation styles and bibliography-management edge cases in the first pass
- Trust the LLM to generate bibliographic records without external verification

## Acceptance Criteria

- [ ] `texlyre` runs locally in this repo with Kuhn-specific setup notes documented
- [ ] Editor extension points for slash commands and citation insertion are mapped
- [ ] In-browser Qwen 3 1.7B feasibility is evaluated with concrete performance and packaging constraints
- [ ] `/cite` flow is specified end-to-end, from sentence capture to validated reference insertion
- [ ] `/cite` supports optional user hints that influence query generation without bypassing validation
- [ ] Citation providers are configurable and at least the initial default set is supported at the interface level
- [ ] Suggested references are grounded in retrieved source metadata rather than model-only generation
- [ ] Evaluation plan exists for citation quality, hallucination resistance, and UX usefulness

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Bootstrap the TeXlyre fork for Kuhn development](stories/001-bootstrap-texlyre-fork.md) | done | M |
| 002 | [Map editor extension points for slash commands and citation insertion](stories/002-map-extension-points.md) | done | M |
| 003 | [Spike in-browser Qwen 3 1.7B integration](stories/003-spike-browser-llm.md) | done | L |
| 004 | [Design the research assistant command UX](stories/004-design-command-ux.md) | done | M |
| 005 | [Define configurable citation providers and validation rules](stories/005-define-citation-provider-layer.md) | done | L |
| 006 | [Implement grounded retrieval for `/cite`](stories/006-implement-cite-retrieval.md) | done | XL |
| 007 | [Integrate `/cite` into the editor and bibliography workflow](stories/007-integrate-cite-command.md) | done | XL |
| 008 | [Evaluate citation quality and hallucination resistance](stories/008-evaluate-citation-quality.md) | draft | M |
| 009 | [Fix CORS failures for arXiv and PsyArXiv providers](stories/009-fix-provider-cors.md) | done | M |
| 010 | [Improve citation search quality with NLP and multi-variant queries](stories/010-improve-search-quality.md) | in-progress | L |
| 011 | [Fix inline `/cite` trigger and arXiv/PsyArXiv provider failures](stories/011-fix-inline-cite-and-provider-failures.md) | ready | M |
