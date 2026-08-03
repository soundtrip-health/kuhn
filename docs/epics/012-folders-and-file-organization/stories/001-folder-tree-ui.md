# Story 012-001: Folder tree UI

**Status:** done
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

- [x] Create folder, rename, and move (drag and dialog) all work from the
      file manager, including folders with contents.
- [x] Empty folders persist and render across reloads.
- [x] Moving a folder into its own descendant is refused server-side.
- [x] Collapsed folders roll up child badges (unseen/unresolved counts) —
      met in the restated form below; the pill divergence is
      [012-005](005-badge-count-divergence.md).
- [x] `files-check` script extended to cover mkdir/move/rename token-free.

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
- Inherited from 012-002, **both resolved in this story's commit**:
  - the hard-coded `draft/references.bib` / `draft/main.md` are now defaults,
    not assumptions: `bib.ts` tracks the path the loaded bibliography actually
    came from, and `main.ts` resolves its fallback document through the tree
    (`fallbackDocument()`) instead of opening `draft/main.md` blind.
  - the dead `FilesHandlers.reopenOpenDoc` field was deleted (zero references
    remain).
- The move route has a second 409 case beyond destination-exists: a **pending
  edit** already waiting at the destination (proposals live only in the DB, so
  storage cannot detect them). Surface it distinctly — the response carries
  `code:'conflict'` and a `paths` array.

## What shipped

The file manager is a real tree: persisted expand/collapse, folder selection as
the upload/create target, create folder, rename, and move by both drag-and-drop
and a keyboard-accessible "Move to…" dialog.

Verified 2026-08-03: `tree-check.mjs` runs green against the live stack —
45 checks, repeatable (two consecutive clean runs). See "Verification record"
below for what the first run found.

### Structure — what was NOT done, deliberately

The panel was never a flat list: it already rendered `<details>`/`<summary>`,
and four behaviours depend on that shape (`visibleTreeItems`' `offsetParent`
filter, `onTreeKeydown`'s `SUMMARY` check, `revealFile`'s `closest('details')`,
and the `.file-list .file-list` indent rule). Flattening to manual rows — the
obvious reading of "make it a real tree" — would have silently broken all four.
The work is additive; ARIA conformance was reached by adding `aria-owns` /
`aria-level` / `aria-setsize` / `aria-posinset` rather than by restructuring.

### Decisions

- **Empty folders ship without a `.keep` sentinel.** `walkTree` already lists
  them, so the listing needs nothing. Verified against history: `history.js`
  shells exactly six git verbs and there is no `checkout`, `reset` or `clean`
  anywhere in the backend — restore is strictly per-file. So an empty folder
  survives every reload and every restore that exists today. It is, however,
  **invisible to version history** (creating one produces zero commits, and
  snapshot-before-destroy is a no-op for it) and would be destroyed by any
  future whole-tree reconstruction. Recorded rather than solved.
- **Keyboard shortcuts are unmodified single keys** on the focused row — `N`
  new folder, `R`/`F2` rename, `M` move, `L` promote, `Delete`/`Backspace`
  delete. `Ctrl/Cmd+Shift+N` was rejected: it is a reserved browser accelerator
  (new Incognito window) that the page never receives. `Backspace` is accepted
  alongside `Delete` because the key labelled "delete" on every Mac keyboard
  emits `Backspace`. Nothing is advertised in `aria-keyshortcuts` that is not
  bound.
- **The project root is a real focusable treeitem**, not a header indicator.
  That is the only keyboard path back to a root upload target, the only place
  the default is announced, and it avoids the 38px `#files-header` (which has
  no room at the 220px breakpoint).
- **Three visual channels never share a token** — open document = `--accent-soft`
  fill, upload target = inset left rule, drop destination = dashed outline —
  because all three can land on the same row simultaneously.
- **Selection is session-scoped**; only the collapsed set is persisted, under
  per-project keys (`kuhn-tree-state:<projectId>`). A restored-from-last-week
  invisible upload target causes surprise uploads. The read is shape-validated,
  so a corrupt value cannot throw out of module init.
- **Agent-created files** get the selected folder as a prompt *hint*, and only
  when that folder is inside `draft/`. Steering an agent write outside `draft/`
  would silently convert a reviewable proposal into a direct write, because
  `isSuggestionPath` gates the review loop on the first path segment.

### Acceptance criterion 4 — restated

"Collapsed folders roll up child badges" is implemented as **the sum of flagged
descendant tree nodes**. It cannot equal the `#toggle-files` pill, which counts
every `suggestMap` key including `base_missing` proposals that have no file on
disk and therefore no tree node. The two numbers legitimately differ; the
divergence is filed as [012-005](005-badge-count-divergence.md).

## Verification record (2026-08-03)

`npm run tree-check` was run against the live stack and came back green
(45 checks) after two fixes — both in the **script**, not the app:

- the upload helper sent the target directory as form field `dir`; the route
  reads **`path`** (and multer only sees fields that precede the file parts),
  so every nested fixture silently landed at the project root. Fixed, and the
  files the failed run leaked at root were cleaned up.
- the rename step pressed `Control+a` for select-all, which on macOS Chromium
  is an Emacs move-to-start binding; now `ControlOrMeta+a`.

Coverage added while closing the ACs: a folder-with-contents move via the
dialog (AC 1's folder case was previously only the refused illegal drop),
drop onto a **collapsed** folder row, empty-folder render after reload, and
deleting the folder **containing the open document** (confirm() accepted;
asserts the editor retargets and the dead path is not resurrected by a
subsequent autosave).

The one interaction not demonstrated token-free is **a rename racing an agent
write** — deferred to [012-004](004-move-hardening.md), whose webapp-vitest
acceptance criteria already own exactly these interleavings (autosave debounce
between rename and event, SSE vs. WS-close ordering).

## Known gaps (owned by open stories)

- Badge rollup vs. the unseen pill diverge for proposed-but-nonexistent files —
  [012-005](005-badge-count-divergence.md).
- `mkdir` publishes no project event, so a collaborator does not see a new
  empty folder until their next tree refresh — [012-004](004-move-hardening.md).
- `resolveSafe` returns a **500** when an ancestor of the path is a file
  (`realpathDeepestExisting` tolerates only `ENOENT`, so `ENOTDIR` rethrows
  bare). Pre-existing and shared with `readProjectFile`/`writeProjectFile`;
  `mkdir('draft/main.md/sub')` should be a 409 — [012-005](005-badge-count-divergence.md).
- Bibliography behaviour under moved/nested documents — the shape of the gap
  turned out subtler than first recorded here; the full description lives in
  [012-003](003-agent-folder-awareness.md)'s recon notes.
