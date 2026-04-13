# Story 011: Fix inline `/cite` trigger and arXiv/PsyArXiv provider failures

**Status:** ready
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Finish two known issues deferred from Stories 007 and 009:
1. Typing `/cite` + Enter inline does not trigger the modal
2. arXiv and PsyArXiv searches fail in the browser

---

## Issue 1 — Inline `/cite` detection (from Story 007)

### What was tried

`CiteCommandExtension.ts` uses `Prec.highest(keymap.of([...]))` to intercept Enter when the current line is `/cite...`. The priority was raised in Story 007 but the modal still does not open.

### What to investigate

- Check whether `Prec.highest` is actually being respected — other Enter handlers (e.g., list continuation, auto-indent, Vim mode if enabled) may be consuming the event before it reaches our handler
- Consider switching from a keymap to a `ViewPlugin` with an `inputHandler` that fires on every character insertion — this would detect `/cite\n` as a sequence rather than competing for the Enter key
- Check whether the line-detection logic handles multiline selections, indented `/cite`, or `/cite` that appears after existing content on the same line

### Acceptance Criteria

- [ ] Typing `/cite` followed by Enter on a blank line opens the cite modal
- [ ] Typing `/cite <hints>` followed by Enter opens the modal with hints pre-filled
- [ ] The detection does not fire spuriously when `/cite` appears inside LaTeX commands (e.g., `\citeauthor`)

---

## Issue 2 — arXiv and PsyArXiv provider failures (from Story 009)

### arXiv

Story 009 switched from `export.arxiv.org/api/query` (no CORS) to the Semantic Scholar Graph API. The provider code was updated but searches may still fail. Things to check:

- Whether the Semantic Scholar API is returning results with `externalIds.ArXiv` populated (some fields may require explicit inclusion)
- Whether the `SS_FIELDS` constant includes all needed fields
- Whether the response shape matches what `ssPaperToEntry` expects — log the raw response to verify
- Semantic Scholar rate limits (100 req / 5 min unauthenticated) — could cause 429s under load

### PsyArXiv

Story 009 changed the search parameter from `filter[title]` to `filter[q]`. The OSF Preprints v2 API may not support `filter[q]` as a full-text search parameter. Things to check:

- Whether `filter[q]` is a documented OSF API parameter or silently ignored/rejected
- The OSF API documentation for `/v2/preprints/` filtering options
- Whether returning zero results is better handled as a graceful empty result rather than a provider failure
- Alternative: use Semantic Scholar for PsyArXiv search as well (it indexes PsyArXiv preprints)

### Acceptance Criteria

- [ ] arXiv search returns results in the browser without errors
- [ ] arXiv ID lookup works in the browser
- [ ] PsyArXiv search returns results in the browser without errors
- [ ] Both providers fail gracefully (show as "failed" in the UI, not crash) if the API is unavailable
