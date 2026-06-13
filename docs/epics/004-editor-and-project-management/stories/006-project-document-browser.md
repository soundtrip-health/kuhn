# Story 006: Project & document browser

**Status:** ready
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** L

## Goal

Give the webapp real navigation across the org → project → document hierarchy.
Replace `main.ts`'s `activeProject()` "grab the first project" hack with an
org/project switcher, a projects dashboard with a new-project flow, and document
navigation tied to the file system. Opening a `.md` is "opening a document";
reopening a project restores the last document.

## Acceptance Criteria

- [ ] An **org/project switcher** lets the user pick the active organization and
      project without a full reload, driven by `GET /api/orgs` and the
      org-scoped `GET /api/projects` (Story 005).
- [ ] A **projects view** (cards or table) lists the active org's projects and
      supports creating a new project (reusing `POST /api/projects`), then drops
      into the seeding hero (`buildEditorHero` / `startSeeding`) or a blank doc.
- [ ] **Document navigation** uses the existing file tree (`files.ts`): selecting
      a `.md` opens it in the editor via `openDocument(projectId, path)`. The
      file system remains the source of truth for documents (no separate
      documents table).
- [ ] The **active document is persisted per project** (e.g. in
      `projects.config` or a small column) and restored when the project is
      reopened; falls back to a sensible default (e.g. `protocol/main.md` or the
      first `.md`) when none is recorded.
- [ ] Switching projects tears down the open document cleanly (collab provider /
      ydoc disposed via `closeDocument`) and opens the new project's document.
- [ ] `cd webapp && npm run build` is clean.

## Notes

- Files: `webapp/src/main.ts` (replace `activeProject()`, bootstrap, project
  state), `webapp/src/api.ts` (add `listOrgs`/org-scoped helpers), `files.ts`
  (already renders the tree; reuse `refreshTree` + open handlers), and a new
  switcher/dashboard UI module consistent with the "Column" design tokens.
- "Document" stays filesystem-backed per `docs/architecture.md` §Data Model
  (documents are `.md` files). The persistence here is just remembering which
  file was open, not modeling documents in Postgres.
- Reuse existing seeding wiring: `buildEditorHero` (`main.ts`), `startSeeding`
  (`seeding.ts`), and `POST /api/projects/:id/seed`.
- Coordinate with Story 007: the switcher and breadcrumb share the same active
  org/project/document state — define that state once and have both consume it.
- Depends on Story 005 (org-scoped endpoints, session).
