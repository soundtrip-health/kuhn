# Epic 008: Trust & the Writing Loop

**Status:** draft
**Created:** 2026-07-19
**Priority:** #1 of the 2026-07 roadmap (008 → 009 → 010)

## Goal

Make agent involvement in the manuscript **reviewable, reversible, and
verifiable**. Today agents write files directly and the user finds out via a
badge; there is no history, no way to audit a citation's support, and review
feedback arrives as chat walls. For the target user — a PI whose name goes on
the paper (often in a regulated context) — trust in what the AI touched is the
product's core promise. Each story hardens one leg of it:

- **Reviewable:** agent edits become suggestions the PI accepts per-hunk (001)
- **Reversible:** every version of the document is recoverable (002)
- **Verifiable:** every citation is checked against what the paper actually says (003)
- **Discussable:** feedback lives in the margin, anchored to the text (004)

## Key design decisions (to be confirmed per story)

| Decision | Leaning | Rationale |
|----------|---------|-----------|
| Suggestion granularity | Per-hunk accept/reject on a server-stored change-set | Mirrors the proven `/write` accept/reject block; whole-file accept is a degenerate case |
| Suggestion scope | Draft documents only (`draft/**`); agent-owned files (`research/`, `pm/`) keep direct writes | Review burden belongs on the manuscript, not on agent scratch space |
| History mechanism | Git repo per project directory (was already on Epic 002's deferred list) | Diff/restore/export for free; also closes the "no backups" gap disclosed in `docs/data-pipeline.md` |
| Claim-check evidence | Stored abstracts first (`bib_references.abstract`), PMC OA full text when fetchable | Grounded verdicts only — never judge a citation from model memory |
| Comment anchoring | Yjs relative positions | Anchors survive concurrent edits; plain offsets don't |

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Suggestion mode for agent edits](stories/001-suggestion-mode.md) — agent writes to draft docs land as pending diffs with per-hunk accept/reject | draft | L |
| 002 | [Document version history](stories/002-version-history.md) — snapshot on save + agent-job boundaries; timeline, diff, restore | draft | L |
| 003 | [Citation claim-checking](stories/003-citation-claim-check.md) — Reviewer verifies every `[@key]` against retrieved evidence | draft | L |
| 004 | [Margin comments](stories/004-margin-comments.md) — anchored threads in the document; Reviewer files comments instead of chat walls | draft | L |

## Sequencing

002 (version history) first — it is the safety net that makes 001 cheap to
trust and simple to build (a rejected suggestion is just a restore). 001 next.
003 and 004 are independent of each other; 003's natural output surface is
004's comment anchors, so 004 before 003 if both are staffed, but 003 can ship
first with a checklist-file output and adopt anchors later.
