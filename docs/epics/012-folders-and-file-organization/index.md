# Epic 012: Folders & File Organization

**Status:** in-progress
**Created:** 2026-08-02
**Issue:** [#47](https://github.com/rfdougherty/kuhn/issues/47)

## Goal

Let users organize project files: create folders, move and rename files and
folders, and browse a real tree. The storage layer already supports all of it
— `storage.js` resolves nested paths, `moveProjectEntry` + the
`POST /files/move` route exist, `mkdir` is recursive — but the webapp renders
a flat list with no create-folder, no move UI, and no rename. The real work
is (a) the UI, and (b) making everything keyed by file path survive a move.

## The path-identity problem

Files have no id; **path is identity** everywhere downstream. A move today
emits a delete+create pair and silently orphans:

- **Comments** (`comments.path`, 008-004) — threads vanish from the moved file
- **Yjs rooms** — path-named; a moved-while-open doc leaves a live room on the
  dead path (the 038/041 eviction machinery handles delete, not move)
- **Pending edits, seen-state, unresolved badges** — all path-keyed
  (seen-state already follows moves; the rest don't)

Story 002 makes move a first-class event that carries `from → to` through
every one of these, rather than introducing file ids — a much smaller change
that keeps the storage-as-truth model.

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Folder tree UI](stories/001-folder-tree-ui.md) — real tree in the file manager: expand/collapse, create folder, rename, move via drag + dialog | **done** | M |
| 002 | [Move-aware path consumers](stories/002-move-aware-consumers.md) — a `moved` event kind; comments, Yjs rooms, pending edits, badges follow `from → to` | **done** | L |
| 003 | [Agent & render awareness](stories/003-agent-folder-awareness.md) — agent file tools handle folders well (list shows tree, move_file already exists); render/export and citation paths verified against nested docs; bibliography canonicalized to one path | **done** | S |
| 004 | [Move hardening](stories/004-move-hardening.md) — tombstone a moved Yjs room so a non-compliant client cannot resurrect it; stand up vitest in the webapp and cover the `moved` handler | **done** | S |
| 005 | [Badge divergence & path errors](stories/005-badge-count-divergence.md) — folder rollup vs. the unseen pill disagree on file-less proposals; ancestor-is-a-file paths 500 instead of 409 | ready | S |

## Current state (2026-08-03)

Branch **`epic-012-folders`**, nothing pushed and no PR opened yet — one PR
ships the whole epic when it finishes (decided 2026-08-03). 001–004 are
**done**; only 005 (badge divergence + path-error mapping) remains. 003
settled the bibliography model by user ruling: the reference DB is the truth,
`draft/references.bib` is its one canonical readout (render/export no longer
resolve a bib next to the source), and users are steered to the RA by a
provenance header in the file itself. 004 added the moved-room tombstone and
stood up **webapp vitest** (`webapp/src/move-follow.ts` + its test file — the
move-follow decision logic was extracted from editor.ts/main.ts to be
testable), which 005's rollup work can now lean on.

Judgment calls reviewed at the 2026-08-03 pickup and settled as follows —
reopen only with a reason:

- **Badge semantics (012-001 AC 4 / 012-005):** the rollup and the pill count
  different things by construction. 012-005's recommendation stands — roll
  file-less proposals up to their would-be parent folder, so a proposed new
  file cannot hide behind a collapsed folder. Decided there, recorded here.
- **Agent-created files land in the selected folder as a prompt *hint*,
  `draft/`-only — this is the intended behaviour, not a compromise.**
  Enforcement would let a selected folder outside `draft/` silently convert a
  reviewable proposal into a direct write (`isSuggestionPath` gates the review
  loop on the first path segment). No enforcement story is planned.
- **012-002 deliberately kept `path` as identity** and added no file-id column.
  Every later feature that wants a stable handle for a file (external links,
  for instance) reopens that decision — the reasoning is in that story's Notes.
- **012-004 and 012-005 are confirmed worth doing.** 004's tombstone closes a
  real stale-tab hazard and its webapp-vitest harness is where 001's deferred
  rename-vs-agent-write race gets covered; 005's two items are user-visible
  correctness (disagreeing counts on one screen; a 500 for a plausible typo).

## Sequencing

**Decided at kickoff:** 002 ships first, so 001 can enable move with no
orphaning caveat and no warning banner to remove later. 001–004 are done.
**005 is the last story**; one PR for the whole epic at the end.

## Risks

- **Move-while-open collab** — two clients with the doc open during a move is
  the same class of hazard as the restart-merge two-tab problem; 002 must
  evict-and-redirect atomically (close old room with a redirect code, client
  rejoins new path) and test it at the websocket level.
- **Path assumptions in the webapp** — flat-list assumptions may lurk in
  files.ts/preview/citation pickers; budget a sweep, not spot fixes.
