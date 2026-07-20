# Epic 009: Agent Depth & Cost Control

**Status:** draft
**Created:** 2026-07-19
**Priority:** #2 of the 2026-07 roadmap (008 → 009 → 010)

## Goal

Close the gaps between the six-agent promise and what agents actually do
today, and make what they cost visible and controllable:

- The **Analyst** is the last stub agent — `/figure` shows a toast. Give it a
  real sandboxed analysis capability (001).
- Agents only act when spoken to. A **literature watch** makes the RA useful
  between sessions (002).
- Token spend is invisible until the budget interrupt fires — one Advisor
  seeding run burned 678k input tokens with no gauge. Make spend **live,
  attributable, and cappable** (003).

Companion story in Epic 002: **036 (stop/redirect a running agent)** is the
control half of the same problem — the interrupt mechanism exists in the
runtime but has no user-facing trigger. 036 stays where it is filed; 003 here
assumes it and adds the money dimension.

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Analyst agent: sandboxed figures & tables](stories/001-analyst-sandboxed-analysis.md) — data file → Python in Docker → figure in the draft, `/figure` wired | draft | L |
| 002 | [Literature watch](stories/002-literature-watch.md) — standing RA sweep for new papers on the project's question; memo + one-click add-to-bib | draft | M |
| 003 | [Live spend visibility & ceilings](stories/003-spend-visibility.md) — per-job live meter, per-project/org rollups, enforced org ceiling | draft | M |

## Sequencing

Independent of each other; 003 first is the cheapest and de-risks the other
two (both spend real tokens). 001 is the flagship. All three build on shipped
plumbing: the sandbox invariants (`sandbox.js`), the PubMed/citation stack
(`search.js`, `citations.js`, `add_citation`), and the token counts already
persisted on `jobs`.
