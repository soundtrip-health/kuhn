# Story 010-006: OCR for scanned PDFs

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** M

## Goal

Scanned/image-only PDFs become searchable in the org library instead of
failing ingestion. Epic 006 shipped extraction via `pdftotext` and explicitly
deferred OCR: documents whose text layer is under `INGEST_MIN_TEXT_CHARS`
are marked `failed` today — and older regulatory guidance and archival
papers are exactly the documents orgs upload.

## Sketch

- In `ingest.js`, when `pdftotext` yields under-threshold text, fall back to
  OCR in the same Docker sandbox discipline (`--network none`, read-only
  doc mount, page cap, timeout): `ocrmypdf` (tesseract under the hood) or
  raw tesseract over rasterized pages — pick one image, pin by digest, add
  to the documented pull set.
- Respect `INGEST_MAX_PDF_PAGES`; OCR is slower — a lower OCR-specific page
  cap and a longer timeout, both config.
- Provenance: mark the document row (`org_documents`) as OCR-extracted;
  ingestion status detail says "OCR (scanned document)" so searchers know
  the text may contain recognition errors. Chunking/FTS downstream is
  unchanged.
- A doc that fails both paths keeps today's honest `failed` status with the
  reason.

## Acceptance Criteria

- [ ] A scanned PDF ingests to searchable chunks; `search_org_knowledge`
      returns passages from it with provenance.
- [ ] OCR runs network-isolated with page/time caps; oversized scans fail
      gracefully with a stated reason.
- [ ] OCR-derived documents are labeled as such in the library UI and in
      search-result provenance.
- [ ] Born-digital PDFs never pay the OCR cost (threshold gate unchanged).
- [ ] README/config document the new sandbox image; `docs/data-pipeline.md`
      §3 updated (OCR exists, its caps, no OCR of project files — org
      library only, matching current ingestion scope).

## Notes

- Filed here rather than in Epic 006 because that epic is closed (done
  stories are read-only); its deferred-items note already points forward.
- Handwriting and low-quality scans are out of scope — recognition quality
  is whatever tesseract gives; the label manages expectations.
