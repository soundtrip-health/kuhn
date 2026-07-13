# Story 001: Org document store & storage scope

**Status:** done
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Outcome

All acceptance criteria met (2026-07-12). The first org-scoped content in the
system:

- **Storage scope**: `storage.js` refactored so both scopes share one
  containment core — `resolveSafe` (projects) and the new `resolveOrgSafe`
  (orgs) are thin wrappers over `resolveWithin(root, relPath)`, which keeps
  the absolute-path/`..`/symlink rejection in exactly one place. Org bytes
  live at `<orgsRoot>/<orgId>/library/<docId>/<filename>`
  (`ORGS_ROOT`, default `<KUHN_DATA_DIR>/orgs`), with `readOrgFile`/
  `writeOrgFile`/`deleteOrgEntry` mirroring the project contracts.
- **Schema**: `org_documents` with status lifecycle (`pending` until 002's
  ingestion), source provenance (`upload`/`project-promotion`/
  `guidance-import`), `created_by`, and a unique `(org_id, sha256)` for
  byte-level dedupe. Org deletion with documents is blocked by FK RESTRICT
  (no org-delete endpoint exists yet; the constraint is the guarantee).
- **Routes** (`routes/org-library.js`, all `isMember`-guarded with the
  non-leaking 404): list, multipart upload (shared story-026 error mapping,
  now extracted to `routes/uploads.js` and reused by both routers), metadata,
  raw content, delete (record + bytes together; a failed byte-write rolls
  the metadata row back). Client filenames are reduced to their base name.
- **Promote**: `POST /api/projects/:id/files/promote` in `routes/projects.js`
  behind `authorizeProject` — the org is derived from the project row, never
  from the client. Dedupe returns 200 + `deduped: true`.

Verified: 8 new vitest cases against real in-memory SQLite + real temp
storage roots (round-trip w/ bytes-on-disk assert, dedupe, non-member 404 on
every route, traversal filename contained, delete completeness, promote +
re-promote dedupe + missing-file 404, FK RESTRICT, org-scope escape
rejection) — 176/176 backend tests pass — plus a live curl/node smoke against
a pre-story DB (idempotent migration; upload → list → content → promote →
404 non-member → delete).

## Goal

The foundation: a place to put org-scoped documents. A DB record per library
document, bytes on disk under an org-scoped storage root enforced by
`storage.js`, and membership-guarded CRUD routes. This is the first
org-scoped content in the system — everything content-bearing today is keyed
by `project_id`.

## Acceptance Criteria

- [x] Idempotent schema addition: `org_documents` (id, org_id FK RESTRICT,
      filename, title, mime, size_bytes, sha256, status
      `pending|ingesting|ready|failed`, status_detail, source
      `upload|project-promotion|guidance-import`, source_project_id nullable,
      created_by nullable user id, timestamps). Unique on (org_id, sha256) to
      dedupe re-uploads.
- [x] `storage.js` gains an org scope: files live under
      `<KUHN_DATA_DIR>/orgs/<orgId>/library/` and **all** access goes through
      the same `resolveSafe`-style root enforcement as project files (absolute
      paths, `..`, and symlink escapes rejected). No other module touches org
      paths directly.
- [x] Routes (new `routes/org-library.js`), all gated on `isMember(user,
      orgId)` with 404 on non-member:
      - `GET /api/orgs/:id/library` — list with status
      - `POST /api/orgs/:id/library/upload` — multipart, same multer limits
        pattern as project files; sets status `pending`
      - `GET /api/orgs/:id/library/:docId` — metadata; `/content` for bytes
      - `DELETE /api/orgs/:id/library/:docId` — removes row, file, and (once
        002 exists) index entries
- [x] `POST /api/projects/:projectId/files/promote` copies a project file into
      the owning org's library (source `project-promotion`,
      `source_project_id` set), authorized via the existing project membership
      guard.
- [x] Deleting an org with library documents is blocked (FK RESTRICT) with a
      clear error.
- [x] Vitest coverage: upload/list/delete round-trip; non-member 404; path
      escape rejected; dedupe on identical bytes; promote copies correctly.

## Notes

- Files: `db/schema.sql`, new `db/org-documents.js`, `storage.js` (org scope),
  new `routes/org-library.js`, `routes/files.js` (promote).
- Honors the tenancy invariants: single storage chokepoint, tenant column on
  every row. This story is the invariant-bearing surface of the epic — the
  `storage.js` change deserves focused review.
- Upload size/oversize error mapping should follow whatever Story 002-026
  (Epic 002) lands — coordinate, don't duplicate the multer handling.
- Ingestion is Story 002; documents rest at `pending` until it exists.
