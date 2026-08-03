# Story 012-001: Folder tree UI

**Status:** in-progress
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
- [x] Moving a folder into its own descendant is refused server-side.
- [ ] Collapsed folders roll up child badges (unseen/unresolved counts).
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

## What shipped

The file manager is a real tree: persisted expand/collapse, folder selection as
the upload/create target, create folder, rename, and move by both drag-and-drop
and a keyboard-accessible "Move to…" dialog.

**Status is `in-progress`, not `done`** — the code is built, typechecks, builds
and passes the backend suite (396 tests), but `tree-check.mjs` has **not been
run against a live app**, so no acceptance criterion that says "works from the
file manager" has been demonstrated in a browser. See "Remaining" below.

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

## Remaining before this is `done`

- [ ] Run `npm run tree-check` against a live backend + webapp and fix what it
      finds. Until then AC 1, 2 and 4 are built but not demonstrated.
- [ ] Manual pass on the interactions a script covers poorly: drag onto a
      collapsed folder, delete a folder containing the open document, and a
      rename racing an agent write.

## Known gaps (owned by open stories)

- Badge rollup vs. the unseen pill diverge for proposed-but-nonexistent files —
  [012-005](005-badge-count-divergence.md).
- `mkdir` publishes no project event, so a collaborator does not see a new
  empty folder until their next tree refresh — [012-004](004-move-hardening.md).
- `resolveSafe` returns a **500** when an ancestor of the path is a file
  (`realpathDeepestExisting` tolerates only `ENOENT`, so `ENOTDIR` rethrows
  bare). Pre-existing and shared with `readProjectFile`/`writeProjectFile`;
  `mkdir('draft/main.md/sub')` should be a 409 — [012-005](005-badge-count-divergence.md).
- `render.js` still resolves the bibliography as `references.bib` **next to the
  source document**, so moving a doc away from its bib silently drops the
  bibliography from rendered PDFs and Pandoc exports — [012-003](003-agent-folder-awareness.md).
