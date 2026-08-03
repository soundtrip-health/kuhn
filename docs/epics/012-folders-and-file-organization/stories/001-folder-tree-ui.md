# Story 012-001: Folder tree UI

**Status:** ready
**Epic:** [012 — Folders & File Organization](../index.md)
**Estimate:** M

## Goal

The file manager becomes a real tree: expand/collapse folders, create a
folder, rename, and move files/folders (drag-and-drop plus a keyboard-safe
"Move to…" dialog). Backend support already exists; this story is webapp UI
plus the two small routes it's missing.

## Sketch

- Routes: `POST /files/mkdir` (create empty folder — storage `mkdir` exists;
  needs a `.keep` sentinel or the listing must show empty dirs), and rename
  as a constrained move (same route, same-dir `to`).
- `files.ts`: tree state (expanded set persisted per project in
  localStorage), indent/disclosure rendering with the existing design
  tokens, folder-aware selection. Upload and agent-created files land in the
  currently-selected folder.
- Move UX: drag file/folder onto folder rows + a "Move to…" dialog listing
  folders (covers accessibility and deep trees). Collision → clear error
  from the existing storage `conflict` code, no silent overwrite.
- Guards: no move of a folder into its own subtree (server-side check in the
  move route, not just UI); root not renamable/deletable (already enforced).
- Unresolved-comment badges and seen-dots aggregate up collapsed folders
  (count rolls up so nothing is invisible while collapsed).

## Acceptance Criteria

- [ ] Create folder, rename, and move (drag and dialog) all work from the
      file manager, including folders with contents.
- [ ] Empty folders persist and render across reloads.
- [ ] Moving a folder into its own descendant is refused server-side.
- [ ] Collapsed folders roll up child badges (unseen/unresolved counts).
- [ ] `files-check` script extended to cover mkdir/move/rename token-free.

## Notes

- **Kickoff decision (recorded):** 012-002 ships **first**, so this story can
  enable move with no orphaning caveat and no warning banner to remove later.
  [012-002](002-move-aware-consumers.md) is now `done`.
- Two acceptance criteria are **already met** by 012-002 and just need covering
  from the UI side:
  - moving a folder into its own descendant is refused server-side —
    `moveProjectEntry` now throws `invalid_path` (a 400, where it used to reach
    `rename(2)`, fail `EINVAL` and return a 500 with stray directories left
    behind);
  - `renameEntry` already flushes a prefix-matched open document before moving.
- Inherited from 012-002, to pick up here:
  - `bib.ts:8` hard-codes `draft/references.bib` and `main.ts:51` hard-codes
    `draft/main.md`. Both silently break once those files — or `draft/` itself
    — move, which this story is what makes reachable from the UI. They need
    tree-resolution or a `moved`-aware setter.
  - `FilesHandlers.reopenOpenDoc` (`files.ts:42`) is dead: zero call sites, the
    SSE `moved` event is the single retarget path. Delete the field.
- The move route has a second 409 case beyond destination-exists: a **pending
  edit** already waiting at the destination (proposals live only in the DB, so
  storage cannot detect them). Surface it distinctly — the response carries
  `code:'conflict'` and a `paths` array.
