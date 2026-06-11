# Story 019: Render & Export

**Status:** draft
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

- [ ] Markdown → Typst conversion for the canonical Pandoc/Quarto-flavored markdown
      (likely Pandoc's typst writer; evaluate math, citations, figures, tables)
- [ ] `POST /api/projects/:id/render` (or similar): markdown source → PDF, streamed or
      cached per content hash; clean error surface for compile failures (stderr excerpt)
- [ ] Export endpoints: docx and LaTeX via Pandoc
- [ ] Webapp: PDF preview pane fed by the render endpoint; export buttons download files
- [ ] BibTeX bibliographies resolve during render (citeproc or Typst-native)
- [ ] Render failures (bad markdown, timeout, oversized output) surface as readable
      errors in the UI, not 500s

## Out of Scope

- Watch-mode/incremental rendering (re-render on save is enough for the prototype)
- Custom Typst templates per project type (one default template)
