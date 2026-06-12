# Story 019: Render & Export

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Markdown → PDF preview and docx/LaTeX export for the active project document:
the render pipeline (markdown → Typst → PDF) plus Pandoc export endpoints, surfaced
in the webapp as a preview pane and export buttons.

## Context (from story 018)

Story 018 delivered the sandboxed execution layer this story must build on:

- `agent-backend/src/sandbox.js` exposes `renderTypstPdf(projectId, sourcePath)` and
  `pandocConvert(projectId, sourcePath, outputName)` — Docker, no network, project
  mounted read-only, CPU/memory/time limits, size-capped output. **All rendering goes
  through these helpers; never run Typst/Pandoc in the backend process.**
- Source paths are validated through the storage service; outputs are returned as
  buffers, with temp dirs under `PROJECTS_ROOT/.render-tmp`.
- Images: `ghcr.io/typst/typst:latest`, `pandoc/core:latest` — document the
  `docker pull` in setup; decide whether the backend pre-pulls on startup.

## Acceptance Criteria

- [x] Markdown → Typst conversion for the canonical Pandoc/Quarto-flavored markdown
      (likely Pandoc's typst writer; evaluate math, citations, figures, tables)
- [x] `POST /api/projects/:id/render` (or similar): markdown source → PDF, streamed or
      cached per content hash; clean error surface for compile failures (stderr excerpt)
- [x] Export endpoints: docx and LaTeX via Pandoc
- [x] Webapp: PDF preview pane fed by the render endpoint; export buttons download files
- [x] BibTeX bibliographies resolve during render (citeproc or Typst-native)
- [x] Render failures (bad markdown, timeout, oversized output) surface as readable
      errors in the UI, not 500s

## Out of Scope

- Watch-mode/incremental rendering (re-render on save is enough for the prototype)
- Custom Typst templates per project type (one default template)

## Resolution (2026-06-12)

- **Pipeline:** `agent-backend/src/render.js` — Pandoc (`--standalone`, `--citeproc`
  when `references.bib` sits next to the source) converts markdown → Typst, the
  intermediate `.preview-<hash>.typ` is written next to the source (so relative image
  paths keep resolving inside the read-only `/work` mount), compiled by Typst, then
  deleted. Both stages run through the story-018 sandbox helpers; `pandocConvert` now
  accepts validated long-form extra args.
- **Citations:** resolved via Pandoc citeproc — verified live: `[@dougherty2025]`
  renders as "(Dougherty et al. 2025)" plus a formatted bibliography (pdftotext).
  Math (inline LaTeX) survives the typst writer; the demo doc compiles.
- **Caching:** content-hash (source + bib) → PDF, bounded LRU-ish map (20 entries),
  `X-Render-Cache: hit|miss` header; concurrent identical renders share one sandbox run
  (the temp `.typ` name is hash-derived, so parallel runs would clobber each other).
- **Routes:** `POST /api/projects/:id/render` (body `{path}` → PDF bytes) and
  `GET /api/projects/:id/export?path&format=docx|tex` (attachment download). Errors:
  compile failure → 422 with stderr excerpt, timeout → 504, oversized → 413, missing
  source → 404 — surfaced verbatim in the preview pane's status line.
- **Webapp:** `webapp/src/preview.ts` — topbar Preview toggle, render-on-open +
  Render button (flushes the save first so the preview matches the editor), iframe
  with a blob URL, `.docx`/`.tex` export buttons.
- **Image pre-pull decision:** the backend does **not** pull images on startup —
  documented one-time `docker pull ghcr.io/typst/typst:latest pandoc/core:latest`
  in TESTING.md instead (keeps startup fast and offline-tolerant).
- **Verification:** `webapp/scripts/render-check.mjs` (12 API + browser checks, no LLM
  tokens); unit tests `src/render.test.js` + `src/routes/render.test.js` (backend suite
  109/109); collab/cite/reload checks still pass.
