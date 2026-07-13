# Story 026: Upload Oversize Error Mapping (backend)

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Outcome

All acceptance criteria met (2026-07-12). A router-level error handler in
`routes/files.js` maps body-parsing errors to the `{ error, code }` shape:
multer `LIMIT_FILE_SIZE` → 413 `too_large`, `LIMIT_FILE_COUNT` → 400
`too_many_files`, and `express.raw`'s `entity.too.large` (oversize PUT) → 413
`too_large`. Both parsers now read `config.storage.maxFileBytes` at request
time instead of import time, so `STORAGE_MAX_FILE_BYTES` overrides and tests
always match `storage.js`.

**Batch semantics decided: all-or-nothing.** Multer enforces the limit while
the stream is parsed (protecting memory from unbounded buffering), so one
oversize file aborts the whole request before anything is written — documented
on the route. The webapp's client-side pre-check (`api.ts` `MAX_UPLOAD_BYTES`)
is retained as the intentional UX fast-path that lets valid files in a mixed
drop still land; if it drifts from an overridden backend limit, the fallback
is now the readable 413 instead of a generic 500 (duplication documented at
both sites).

Verified: 4 new vitest cases (oversize multipart 413, mixed batch
all-or-nothing, 21-file batch 400, oversize PUT 413) — 146/146 backend tests
pass — plus a live probe against a running backend with a real 21 MB body
(clean 413 JSON mid-stream, valid sibling absent from tree, small upload still
201). `files-check.mjs` gained the oversize/all-or-nothing assertions.

## Goal

Make the multipart upload endpoint return a readable, mapped error when a file
exceeds the size limit, instead of a generic 500. Surfaced while building the
file manager (story 014).

## Background — the gap

`POST /api/projects/:projectId/files/upload` (`agent-backend/src/routes/files.js`)
uses `multer({ limits: { fileSize: config.storage.maxFileBytes } })`. When a
file exceeds that limit, multer aborts the **whole** multipart request with a
`MulterError('LIMIT_FILE_SIZE')` *before* the route handler runs. There is no
Express error-handling middleware (`agent-backend/src/index.js` mounts routers
with no `(err, req, res, next)` handler), so the error falls through to Express's
default handler and the client receives a generic `500` (HTML), not the
`{ error, code }` shape every other storage error uses.

Two consequences:
1. The client can't show the backend's readable "too large" message for that path.
2. multer's abort drops the entire batch, so other (valid) files in the same
   upload don't land either.

**Current mitigation (story 014, webapp-only).** `webapp/src/api.ts` `uploadFiles`
pre-checks each file against `MAX_UPLOAD_BYTES` (mirrors the backend default) and
excludes oversize files from the request, reporting a readable client-side error
so the rest still upload. This hides the gap for normal UI use but (a) duplicates
the limit on the client, which can drift if `STORAGE_MAX_FILE_BYTES` is
overridden, and (b) leaves the API itself returning a 500 for a direct oversize
upload.

## Scope

- Add an error-handling path for the upload route (a `(err, req, res, next)`
  handler on the router, or wrap `upload.array('files')`) that maps
  `MulterError` codes to the storage status table — `LIMIT_FILE_SIZE` → 413
  `{ error, code: 'too_large' }`, `LIMIT_FILE_COUNT` → 400, etc.
- Consider whether the per-file `writeProjectFile` `too_large` check (which the
  loop already raises and `handle()` already maps to 413) should be the single
  source of truth — e.g. raise or remove multer's `fileSize` limit so partial
  batches can still write the valid files and report the oversize ones. Decide
  and document the batch semantics (all-or-nothing vs best-effort).
- Once the API returns a mapped 413, simplify `webapp/src/api.ts` `uploadFiles`
  to rely on the backend message (drop or relax the hardcoded `MAX_UPLOAD_BYTES`
  pre-check, or keep it only as a fast-path UX hint) so the limit isn't
  duplicated.

## Acceptance Criteria

- [x] A direct multipart upload of an oversize file returns `413` with
      `{ error, code: 'too_large' }`, not a generic 500
- [x] Batch semantics for a mix of valid + oversize files are defined and
      tested (which files land, what the response reports) — all-or-nothing;
      nothing lands, response is the mapped 413
- [x] `webapp/scripts/files-check.mjs` gains an oversize-upload assertion
- [x] The size limit is not silently duplicated between client and server (or
      the duplication is documented as an intentional UX fast-path) —
      documented as the intentional fast-path at both sites

## Out of Scope

- File-content extraction / ingestion (separate Advisor concern)
- Per-file streaming upload progress
