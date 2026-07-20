# Story 009-002: Literature watch

**Status:** draft
**Epic:** [009 — Agent Depth & Cost Control](../index.md)
**Estimate:** M

## Goal

The RA keeps watching the literature between sessions: new papers matching the
project's research question surface as a short memo with one-click
add-to-bibliography, instead of the PI re-running searches by hand.

## Sketch

- **Config:** per-project watch settings stored in `projects.config`
  (enabled, query — seeded from the wizard's research question, editable;
  last-checked timestamp; spend cap per sweep).
- **Trigger (v1, no scheduler):** check on project open when the last sweep
  is older than the interval (default weekly), plus a manual "Check now"
  button. A real background scheduler is deliberately out of scope — it is a
  new operational surface (the backend currently only works on request) and
  v1's value doesn't need it. Note it as the v2 upgrade.
- **Sweep:** PubMed (and arXiv where relevant) restricted to since-last-check;
  dedupe against `bib_references` (PMID/DOI) and previously-memoed papers; the
  RA writes `research/lit-watch-YYYY-MM-DD.md` — per paper: citation line,
  abstract-grounded two-sentence relevance note, and its PMID.
- **Add-to-bib:** memo entries link to the existing `add_citation` path
  (verified metadata, dedupe, `.bib` upsert) — one click in chat or the memo.
- Empty sweeps write nothing and say so quietly in the feed.

## Acceptance Criteria

- [ ] With a watch enabled, reopening a stale project produces (at most) one
      memo of new, deduplicated, relevance-annotated papers; the file lands
      in the tree with the RA's badge.
- [ ] Relevance notes are grounded in fetched abstracts, and each entry
      carries its PMID/DOI; adding one to the bib goes through the verified
      `add_citation` path.
- [ ] No duplicates across sweeps or against the existing bibliography.
- [ ] Each sweep respects a token cap (config default), and its spend is
      visible per 009-003.
- [ ] Watch settings are editable in the project setup UI; disabled by
      default for existing projects.

## Notes

- Semantic Scholar as a second source (recommended by the Epic 003 eval)
  slots in cleanly here and would also feed 008-003's evidence pool — file
  separately if pursued.
