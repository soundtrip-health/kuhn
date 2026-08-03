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

- If this ships before 012-002, moving a file with comment threads or an
  open collab session has known orphaning issues — either gate move UI on
  002 or ship with a visible warning; decide at kickoff and record here.
