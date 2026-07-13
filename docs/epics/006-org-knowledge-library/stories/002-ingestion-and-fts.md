# Story 002: Ingestion pipeline & FTS index

**Status:** ready
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Goal

Turn stored bytes into searchable knowledge: extract text from uploaded
documents (sandboxed), chunk it, and index it in SQLite FTS5. Documents move
through a visible status lifecycle (`pending → ingesting → ready|failed`) so
the UI and the file manager's dormant `ingesting`/`done` badges have real data.

## Acceptance Criteria

- [ ] Sandboxed extraction via `sandbox.js` (never in-process parsers):
      - md/txt: read directly; docx/html/odt: Pandoc (image already pulled);
      - PDF: poppler `pdftotext` via a pinned image (document the pull in
        README alongside the Typst/Pandoc images). Text-layer PDFs only — a
        scanned/no-text PDF yields status `failed` with a human-readable
        `status_detail` ("no extractable text — OCR not supported").
- [ ] Chunking: heading-aware where structure exists, target ~500–1000 tokens
      per chunk with overlap; each chunk keeps `{ doc_id, seq, heading_path }`.
- [ ] Schema: `org_document_chunks` (id, doc_id FK CASCADE, seq, heading_path,
      text) + an FTS5 virtual table (`content=` external-content pattern
      against the chunks table) with BM25 ranking. Migration idempotent.
- [ ] Ingestion runs async after upload (and after promote/import): status
      flips `pending → ingesting → ready|failed`; re-uploading a changed file
      re-extracts and replaces that doc's chunks atomically.
- [ ] Status transitions are emitted as events — through the Epic 005 project…
      hub if present (org-scoped channel or per-doc notice), else exposed by
      the list endpoint for polling. Soft dependency: this story must not
      hard-require Epic 005.
- [ ] `DELETE` of a document (Story 001) purges its chunks and FTS entries.
- [ ] A `searchOrgKnowledge(orgId, query, limit)` function in
      `db/org-documents.js` returns ranked chunks with `{ docId, title,
      filename, headingPath, snippet, rank }` — this is the seam Story 003's
      tool calls.
- [ ] Import path for the curated repo corpus: a small script or route to
      ingest chosen `guidance-docs/` subtrees into a given org (source
      `guidance-import`). Used as the eval fixture.
- [ ] Vitest coverage: extraction dispatch per mime; failed-status on
      no-text; chunk replace on re-upload; FTS round-trip returns the planted
      passage first for a distinctive query.

## Notes

- Files: `db/schema.sql`, `db/org-documents.js`, new
  `agent-backend/src/ingest.js`, `sandbox.js` (poppler runner), scripts entry
  for the guidance import.
- Keep the extract step bounded: max pages/bytes guard, timeout via the
  existing sandbox limits — a hostile PDF must not wedge the process.
- Embeddings are explicitly out of scope; revisit only with an FTS relevance
  eval in hand (Story 003 Notes).
- `bib_references.abstract` could join the same FTS pattern later — note as a
  possible follow-up, not scope.
