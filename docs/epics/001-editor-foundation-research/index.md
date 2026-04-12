# Epic 001: Editor Foundation Research

**Status:** In Progress
**Created:** 2026-04-11

## Goal

Evaluate open-source LaTeX/Typst editor projects to determine the best foundation for Kuhn's webapp. The chosen foundation must support browser-based editing with live preview, be extensible enough for agent integration (slash commands, inline results), and have a license compatible with our distribution model.

## Context

Two leading candidates have been identified:

1. **TeXlyre** (https://github.com/TeXlyre/texlyre) — a feature-rich web-based LaTeX editor. Strong UX but licensed under AGPL, which imposes copyleft obligations on the entire webapp if deployed as a network service.

2. **BusyIDE / BusyTeX** (https://github.com/busytex/busyide) — MIT-licensed, uses WASM to compile TeX entirely in the browser. Less polished but far more permissive licensing.

We should also survey any other viable candidates (Overleaf CE, SwiftLaTeX, etc.) and consider building from primitives (CodeMirror 6 + custom language support).

## Key Decision Factors

- **License** — can we build a commercial/SaaS product on it? AGPL vs MIT vs Apache 2.0 matters enormously.
- **Feature completeness** — syntax highlighting, autocomplete, error reporting, SyncTeX, BibTeX integration
- **Extensibility** — can we add slash commands, agent sidebar, inline results?
- **Typst support** — does it support Typst or can Typst be added?
- **Compilation model** — server-side vs WASM vs hybrid
- **Community & maintenance** — active development? responsive maintainers?
- **Code quality** — is the codebase something we can confidently build on?

## Acceptance Criteria

- [x] All candidate projects evaluated against the decision factors above
- [x] License analysis completed with legal implications documented
- [ ] Proof-of-concept spike for the top 1-2 candidates (can we add a slash command?)
- [x] Architecture recommendation written with trade-offs
- [ ] Decision made and documented

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Survey candidate projects](stories/001-survey-candidates.md) | done | M |
| 002 | [Deep-dive: TeXlyre](stories/002-deep-dive-texlyre.md) | ready | L |
| 003 | [Deep-dive: BusyIDE](stories/003-deep-dive-busyide.md) | ready | L |
| 004 | [License analysis](stories/004-license-analysis.md) | done | M |
| 005 | [Extensibility spike](stories/005-extensibility-spike.md) | draft | L |
| 006 | [Recommendation & decision](stories/006-recommendation.md) | in-progress | M |
