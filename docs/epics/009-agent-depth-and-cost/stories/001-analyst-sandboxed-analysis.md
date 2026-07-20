# Story 009-001: Analyst agent — sandboxed figures & tables

**Status:** draft
**Epic:** [009 — Agent Depth & Cost Control](../index.md)
**Estimate:** L

## Goal

The Analyst goes from stub to the agent that closes the manuscript loop: give
it a data file, get a publication-quality figure (or table) in the draft, with
the code that produced it stored as provenance. `/figure` in the editor
dispatches it for real.

## Sketch

- **`run_analysis` tool** (Analyst-only): the agent supplies a Python script;
  the backend executes it in Docker under the exact `sandbox.js` invariants
  (`--network none`, CPU/mem/pid caps, timeout, project mounted read-only,
  a writable `/out`). Image: a pinned scientific-Python image
  (pandas/matplotlib/numpy/scipy) added to the pulled set in the README/config.
- Outputs land in `figures/`: the rendered `figure-N.png`/`.svg`, the script
  as `figure-N.py`, and a `figure-N.json` provenance stub (inputs, image
  digest, timestamp). All through `writeProjectFile` → activity feed.
- **Editor:** `/figure` routes a prompt + current selection to the Analyst;
  on completion the figure is inserted at the caret as an image block with a
  drafted caption (Crepe's image block already renders project files).
- Stdout/stderr are returned to the agent (bounded by the existing sandbox
  output cap) so it can iterate on script errors within its turn budget.
- Tables: same path, emitting markdown directly instead of an image.

## Acceptance Criteria

- [ ] CSV in `sources/` + "/figure plot X vs Y by group" → a rendered figure
      inserted in the draft with a caption, within one Analyst run.
- [ ] The producing script and provenance record sit next to every figure;
      re-running the script reproduces the image.
- [ ] Sandbox flags are identical to render/export (network none, read-only
      project mount, caps); the analysis image is pinned by digest, not
      `:latest`.
- [ ] A failing script surfaces its stderr to the agent (bounded) and the
      run degrades to an explanation in chat, never a broken half-insert.
- [ ] Analyst tool grants and prompt updated in `db/seed-data.js` /
      `db/prompts/analyst.md`; `npm run db:seed` documented.

## Notes

- Security posture is inherited, not new: model-authored code already runs in
  this sandbox for document conversion; the analysis image just adds Python.
  Keep treating all sandbox output as untrusted (`sandbox.js` doctrine).
- Out of scope: long-running jobs, R, GPU. File follow-ups if needed.
