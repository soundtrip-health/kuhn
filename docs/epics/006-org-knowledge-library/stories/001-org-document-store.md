# Story 001: Org document store & storage scope

**Status:** ready
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Goal

The foundation: a place to put org-scoped documents. A DB record per library
document, bytes on disk under an org-scoped storage root enforced by
`storage.js`, and membership-guarded CRUD routes. This is the first
org-scoped content in the system — everything content-bearing today is keyed
by `project_id`.

## Acceptance Criteria

- [ ] Idempotent schema addition: `org_documents` (id, org_id FK RESTRICT,
      filename, title, mime, size_bytes, sha256, status
      `pending|ingesting|ready|failed`, status_detail, source
      `upload|project-promotion|guidance-import`, source_project_id nullable,
      created_by nullable user id, timestamps). Unique on (org_id, sha256) to
      dedupe re-uploads.
- [ ] `storage.js` gains an org scope: files live under
      `<KUHN_DATA_DIR>/orgs/<orgId>/library/` and **all** access goes through
      the same `resolveSafe`-style root enforcement as project files (absolute
      paths, `..`, and symlink escapes rejected). No other module touches org
      paths directly.
- [ ] Routes (new `routes/org-library.js`), all gated on `isMember(user,
      orgId)` with 404 on non-member:
      - `GET /api/orgs/:id/library` — list with status
      - `POST /api/orgs/:id/library/upload` — multipart, same multer limits
        pattern as project files; sets status `pending`
      - `GET /api/orgs/:id/library/:docId` — metadata; `/content` for bytes
      - `DELETE /api/orgs/:id/library/:docId` — removes row, file, and (once
        002 exists) index entries
- [ ] `POST /api/projects/:projectId/files/promote` copies a project file into
      the owning org's library (source `project-promotion`,
      `source_project_id` set), authorized via the existing project membership
      guard.
- [ ] Deleting an org with library documents is blocked (FK RESTRICT) with a
      clear error.
- [ ] Vitest coverage: upload/list/delete round-trip; non-member 404; path
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
