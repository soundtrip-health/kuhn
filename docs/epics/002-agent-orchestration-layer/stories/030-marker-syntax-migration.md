# Story 030: Migrate in-text markers from `[ ]` brackets to `\x{}` commands

**Status:** draft
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Switch Kuhn's in-text annotation markers from the current bracket convention
(`[Author, Year]`, `[TODO: ...]`, `[TODO: verify]`, `[TODO: citation needed]`) to a
backslash-command grammar (`\cite{...}`, `\todo{...}`, plus new `\review{...}` /
`\note{...}`). This is a single **atomic** migration across the agent prompts, the
citation tooling, the citation audit, the render/export pipeline, and the Milkdown
editor — not a partial change.

## Why

Decided during the AGENT_GUIDANCE.md ingestion (2026-07-09). The bracket convention
is ambiguous in scientific prose: numeric citations `[1]`, `[12,13]`, intervals
`[0, 1]`, dose ranges, and Markdown's own link syntax `[text](url)` all collide with a
bracket-keyed parser, producing false positives and making a *marker* indistinguishable
from *literal bracketed content*. `\<alpha>{...}` is an unambiguous grammar with a clean
failure mode — an unknown command (e.g. a mistyped `\Cite{}`) surfaces as a warning
rather than silently mis-parsing or silently not-parsing.

The predecessor project used exactly this grammar; the generic guidance imported in the
same session assumes it. Adopting it also aligns Kuhn with a convention scientific
writers already know from LaTeX/BibTeX.

## Design decisions (already made)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Grammar | `\<alpha>{...}`; comma-separate multiple keys inside one command (`\cite{A, B}`) | Unambiguous; parser can warn on unknown commands |
| Marker set | `\cite{key}`, `\patent{pub_number}`, `\todo{...}` (with `\todo{verify: ...}` / `\todo{citation needed: ...}` / `\todo{PI: ...}` forms), and **new** `\review{...}` (reviewer) / `\note{...}` (PI) inline markers | Covers today's markers plus the review/PI markers Kuhn lacks |
| **Marker naming** | **Avoid TeX primitives.** Do **not** use `\cr` or `\pi` (TeX table-newline and π). Use `\review` / `\note` instead | Prevents render collisions |
| Render safety | Markers are resolved/stripped in a **pre-pass before** the Typst/Pandoc hand-off in `render.js`; `\todo{}` renders as a visible callout, `\review{}`/`\note{}` must be resolved before render | Kuhn renders markdown → Typst → PDF and via Pandoc, not raw LaTeX, so the pre-pass owns all backslash handling |
| Editor | `\cite{}` renders as a citation chip in the Milkdown/Crepe surface via the existing custom citation plugin; other markers render as styled inline widgets or plain text | Keep the WYSIWYG surface clean |

## Acceptance Criteria

- [ ] Marker grammar + set defined in one place; parser warns on unknown `\command{}`
- [ ] Agent prompts (`db/prompts/*.md`) updated to emit `\cite{}` / `\patent{}` / `\todo{}` and (reviewer/PI) `\review{}` / `\note{}`; re-seeded via `npm run db:seed`
- [ ] `citation.ts` / `cite-picker.ts` / `bib.ts` produce and resolve `\cite{}` (chip insert, bib upsert, round-trip)
- [ ] Citation audit (`scripts/read_sections.py --citations`, and any backend equivalent) keys on `\cite{}`; audit categories preserved (`no_bib_match`, `no_patent_match`, `unknown_marker`, orphaned entries)
- [ ] `render.js` pre-pass: resolves `\cite{}` to the numbered/author-year bibliography, renders `\todo{}` as a callout, and errors (or strips on explicit request) on unresolved `\review{}`/`\note{}`
- [ ] Milkdown/Crepe editor renders `\cite{}` as a chip; other markers display acceptably and survive save/round-trip
- [ ] Migration of existing documents: a converter for `[Author, Year]` → `\cite{}` and `[TODO...]` → `\todo{...}` (or a documented decision that only new content uses the new grammar)
- [ ] Tests: parser grammar, audit categories, render pre-pass, editor round-trip

## Notes

- **Do not ship partially.** If prompts emit `\cite{}` while the tooling still expects
  `[Author, Year]` (or vice-versa), agents produce markers the pipeline can't resolve —
  worse than either end state. Land prompts + tooling + audit + render + editor together.
- Related surfaces: Epic 002 story 016 (`/cite` port), Epic 004 stories 001–003 (Crepe
  editor + custom plugins). The chip rendering path from those stories is what this
  migration re-points at `\cite{}`.
- Until this ships, the prompts and the imported generic guidance intentionally keep the
  `[ ]` convention.
