# Story 002: Ingestion pipeline & FTS index

**Status:** done
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Outcome

All acceptance criteria met (2026-07-12). New `src/ingest.js` +
chunk/FTS layer in `db/org-documents.js`:

- **Extraction, sandboxed**: md/txt (and bib/csv/json, indexable as-is) read
  in-process; docx/odt/html/rtf/epub via Pandoc (`-t gfm` so headings
  survive); **PDF via poppler `pdftotext`** in a new pinned-by-env image
  (`SANDBOX_POPPLER_IMAGE`, default `minidocks/poppler:latest`) — decision
  recorded; pull documented in README/AGENTS.md. Only the single document's
  directory is mounted, read-only; page cap via `-l` (`INGEST_MAX_PDF_PAGES`,
  200). No-text extraction → `failed` with "no extractable text — scanned
  PDFs need OCR, which is not supported".
- **Chunking**: heading-aware for markdown-shaped text (chunks carry
  `heading_path` like "Methods > Statistics", fresh chunk per section),
  blank-line blocks for plain text; ~800-token target / ~1100 hard cap with
  short-block overlap across boundaries.
- **Index**: `org_document_chunks` + `org_chunks_fts` (FTS5 external-content)
  with insert/delete triggers keeping the index in sync — including through
  `org_documents` FK cascades, so deleting a document clears its passages.
  `searchOrgKnowledge(orgId, query, limit)` returns BM25-ranked passages with
  provenance; queries are term-quoted so hostile FTS syntax can't error.
- **Lifecycle**: `storeOrgDocument` queues async ingestion for fresh
  documents (and retries when identical bytes re-arrive for a `failed` doc);
  `pending → ingesting → ready|failed` transitions publish `doc_status`
  events on a new **org-scoped hub + `GET /api/orgs/:id/events` SSE feed**
  (soft Epic-005 dependency satisfied with an org feed rather than
  overloading the project hub; list endpoint remains the poll fallback).
- **Corpus import**: `npm run import:guidance -- <orgId> [subdir]` walks
  `guidance-docs/`, stores as `guidance-import`, ingests inline, and reports
  per-file status.

Verified: 11 new vitest cases (187/187 pass) — chunking heading-paths/bounds,
extraction dispatch per format with injected runner (image + cmd asserted),
unsupported-type rejection, ready-lifecycle with events, org + status search
scoping, no-text fail-soft, re-ingest replacement, cascade cleanup, hostile
query safety. **Live**: full `guidance-docs/` corpus (12 regulatory PDFs +
HTML + md) imported through real sandboxed extraction — 14/14 ready, dedupe
holding across runs — and 5 domain queries ("non-inferiority margin
justification", "target trial emulation design", …) each ranked the expected
document first. HTTP loop: upload → `pending` response → org feed streamed
`ingesting`/`ready` → non-member 404.

Environment note: PDF/docx ingestion requires the data dir to be
Docker-shareable (same constraint render.js documents) — the default
`./data` under the repo is fine; a `/tmp` data dir on macOS is not.

## Goal

Turn stored bytes into searchable knowledge: extract text from uploaded
documents (sandboxed), chunk it, and index it in SQLite FTS5. Documents move
through a visible status lifecycle (`pending → ingesting → ready|failed`) so
the UI and the file manager's dormant `ingesting`/`done` badges have real data.

## Acceptance Criteria

- [x] Sandboxed extraction via `sandbox.js` (never in-process parsers):
      - md/txt: read directly; docx/html/odt: Pandoc (image already pulled);
      - PDF: poppler `pdftotext` via a pinned image (document the pull in
        README alongside the Typst/Pandoc images). Text-layer PDFs only — a
        scanned/no-text PDF yields status `failed` with a human-readable
        `status_detail` ("no extractable text — OCR not supported").
- [x] Chunking: heading-aware where structure exists, target ~500–1000 tokens
      per chunk with overlap; each chunk keeps `{ doc_id, seq, heading_path }`.
- [x] Schema: `org_document_chunks` (id, doc_id FK CASCADE, seq, heading_path,
      text) + an FTS5 virtual table (`content=` external-content pattern
      against the chunks table) with BM25 ranking. Migration idempotent.
- [x] Ingestion runs async after upload (and after promote/import): status
      flips `pending → ingesting → ready|failed`; re-uploading a changed file
      re-extracts and replaces that doc's chunks atomically.
- [x] Status transitions are emitted as events — through the Epic 005 project…
      hub if present (org-scoped channel or per-doc notice), else exposed by
      the list endpoint for polling. Soft dependency: this story must not
      hard-require Epic 005.
- [x] `DELETE` of a document (Story 001) purges its chunks and FTS entries.
- [x] A `searchOrgKnowledge(orgId, query, limit)` function in
      `db/org-documents.js` returns ranked chunks with `{ docId, title,
      filename, headingPath, snippet, rank }` — this is the seam Story 003's
      tool calls.
- [x] Import path for the curated repo corpus: a small script or route to
      ingest chosen `guidance-docs/` subtrees into a given org (source
      `guidance-import`). Used as the eval fixture.
- [x] Vitest coverage: extraction dispatch per mime; failed-status on
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
