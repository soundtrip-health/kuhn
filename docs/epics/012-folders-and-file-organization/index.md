# Epic 012: Folders & File Organization

**Status:** ready
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
| 001 | [Folder tree UI](stories/001-folder-tree-ui.md) — real tree in the file manager: expand/collapse, create folder, rename, move via drag + dialog | draft | M |
| 002 | [Move-aware path consumers](stories/002-move-aware-consumers.md) — a `moved` event kind; comments, Yjs rooms, pending edits, badges follow `from → to` | draft | L |
| 003 | [Agent & render awareness](stories/003-agent-folder-awareness.md) — agent file tools handle folders well (list shows tree, move_file already exists); render/export and citation paths verified against nested docs | draft | S |

## Sequencing

001 can ship first behind the existing move route (accepting that moved
files temporarily shed comments — or 001 simply excludes move until 002
lands; decide at kickoff). 002 is the substance. 003 is a verification
sweep more than a build.

## Risks

- **Move-while-open collab** — two clients with the doc open during a move is
  the same class of hazard as the restart-merge two-tab problem; 002 must
  evict-and-redirect atomically (close old room with a redirect code, client
  rejoins new path) and test it at the websocket level.
- **Path assumptions in the webapp** — flat-list assumptions may lurk in
  files.ts/preview/citation pickers; budget a sweep, not spot fixes.
