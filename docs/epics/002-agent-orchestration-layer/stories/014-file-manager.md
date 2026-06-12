# Story 014: File Manager — Upload, Preview, Manage

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Turn the read-only file tree (story 013 shell) into a working file manager: upload
project materials (drag-drop + picker), preview non-markdown files (PDF, images,
text), and delete/rename entries. All operations go through the story-018 storage
API, which already exists — **this story is webapp-only; no backend changes are
expected.**

## Background — what exists today

- **Backend (story 018, complete).** `agent-backend/src/routes/files.js`:
  - `GET /api/projects/:projectId/files[?path=subdir]` → `{ tree }` (recursive `TreeNode[]`)
  - `GET /api/projects/:projectId/file?path=…` → raw bytes with a correct
    `Content-Type` (md/txt/bib/csv/json/pdf/png/jpg/svg/… mapped; else octet-stream)
  - `PUT /api/projects/:projectId/file?path=…` → create/overwrite from raw body
  - `DELETE /api/projects/:projectId/file?path=…`
  - `POST /api/projects/:projectId/files/move` → body `{ from, to }`
  - `POST /api/projects/:projectId/files/upload` → multipart, field `files`
    (up to 20), optional `path` (target dir). Errors arrive as
    `{ error, code }` with mapped statuses: 413 `too_large`, 409 `conflict`,
    403 `outside_root`, 400 `invalid_path`, 404 `not_found`.
- **Webapp.** `webapp/src/files.ts` renders the tree; `.md` entries open in the
  editor via `onOpenMarkdownFile`; everything else is a disabled button.
  `webapp/src/api.ts` has `getTree`, `readTextFile`, `writeTextFile` — no upload,
  delete, move, or blob helpers yet.
- **Live refresh.** `file_change` AgentEvents already trigger `refreshTree()`
  (`webapp/src/editor.ts:70`, `webapp/src/chat.ts:129`). Events carry
  `{ path, kind: create|update|delete, agent }`.
- **PDF preview pane (story 019).** `webapp/src/preview.ts` displays a rendered
  PDF blob; reuse its display mechanism for previewing stored `.pdf` files.
- **Design (story 025 / `docs/design/handoff/README.md`).** The upload drop zone
  (dashed border, up-arrow icon, "Upload materials…", accepted types in mono
  "PDF · DOCX · TXT · BIB") and per-file status badges are *designed* in 025 and
  *wired* here. If 025 hasn't landed when this starts, build with current styles
  and minimal CSS; 025 restyles.

## Scope

1. **API client helpers** (`webapp/src/api.ts`): `uploadFiles(projectId, files, dir?)`
   (multipart via `FormData`), `deleteFile`, `moveFile`, and a `fileBlobUrl`/`fetchFileBlob`
   helper for previews. Surface backend `{ error }` messages readably (the 413/409
   cases especially).
2. **Upload UI** (`webapp/src/files.ts`):
   - Drop zone in the files panel (and shown prominently in the empty state),
     plus an "Upload" button opening a native file picker (multi-select).
   - Drop onto a directory row targets that directory; panel-level drop targets
     the project root (`sources/` is where seeding expects user materials — default
     the panel-level drop there if the directory exists).
   - Per-file result feedback (toast or inline): uploaded, or the readable error.
   - Tree refreshes after upload.
3. **Preview** (new `webapp/src/file-preview.ts` or extend `preview.ts`):
   - `.pdf` → display in the preview pane (same mechanism as story 019's render
     preview; don't fight over the pane — opening a file preview replaces the
     render preview and vice versa).
   - Images (`.png/.jpg/.jpeg/.svg`) → `<img>` from a blob URL (revoke on close).
   - Text-ish (`.txt/.bib/.csv/.json/.typ/.tex`) → read-only `<pre>` view.
   - Anything else → download link (the GET endpoint already serves bytes).
   - `.md` keeps its existing open-in-editor behavior, unchanged.
4. **Manage**:
   - Delete with a confirm step; block deleting the currently open document
     (or close it first deliberately).
   - Rename via the move endpoint (inline edit on the row is enough).
5. **Per-file status tracking for the 025 design** — keep a client-side map
   `path → { status: new|modified|generated|ingesting|done, originAgent }`
   updated from `file_change` events and upload activity, and expose it to the
   tree renderer. The events already carry `agent`, `path`, `kind`; **no backend
   payload extension needed.** 025 owns the badge visuals; this story owns the data.

## Acceptance Criteria

- [ ] Multi-file upload works via both drag-drop and the picker; files land at the
      intended directory; the tree refreshes and shows them
- [ ] Oversize (413) and conflict (409) uploads show the backend's readable error,
      not a generic failure; other files in the same batch still succeed
- [ ] PDF, image, and text files preview in-app; unknown types offer a download;
      `.md` still opens in the editor exactly as before
- [ ] Delete (with confirmation) and rename work and refresh the tree; deleting or
      renaming the open document doesn't strand the editor
- [ ] File status map (status + originAgent) is maintained from `file_change`
      events and consumable by the tree renderer (025 hook)
- [ ] Token-free scripted check `webapp/scripts/files-check.mjs` (follow the
      existing `*-check.mjs` conventions): upload via the API path the UI uses,
      see it in the tree, preview its content, rename, delete — no live agent calls
- [ ] Existing checks (`smoke`, `cite-check`, `collab-check`, `render-check`)
      still pass

## Out of Scope

- Visual restyle of the panel, badges, and drop zone (story 025 — it consumes
  this story's status map)
- Backend storage changes (018's API is sufficient; if a real gap is found, stop
  and surface it rather than extending silently)
- DOCX/PDF *content extraction* for agents (Advisor ingestion is a separate
  concern; upload just stores bytes)
- File versioning / git integration (epic Deferred list)

## Technical Notes

- `uploadFiles` should send one multipart request per batch (the endpoint accepts
  up to 20 files); don't parallelize per-file PUTs.
- Blob URLs for previews must be revoked when the preview closes or swaps —
  the preview pane (story 019) already manages a blob lifecycle; mirror it.
- The drop zone needs `dragover` prevention at the panel level only; don't make
  the whole window a drop target (mis-drops replace the page).
