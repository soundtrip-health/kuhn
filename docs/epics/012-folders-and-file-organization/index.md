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
| 001 | [Folder tree UI](stories/001-folder-tree-ui.md) — real tree in the file manager: expand/collapse, create folder, rename, move via drag + dialog | in-progress | M |
| 002 | [Move-aware path consumers](stories/002-move-aware-consumers.md) — a `moved` event kind; comments, Yjs rooms, pending edits, badges follow `from → to` | **done** | L |
| 003 | [Agent & render awareness](stories/003-agent-folder-awareness.md) — agent file tools handle folders well (list shows tree, move_file already exists); render/export and citation paths verified against nested docs | ready | S |
| 004 | [Move hardening](stories/004-move-hardening.md) — tombstone a moved Yjs room so a non-compliant client cannot resurrect it; stand up vitest in the webapp and cover the `moved` handler | ready | S |
| 005 | [Badge divergence & path errors](stories/005-badge-count-divergence.md) — folder rollup vs. the unseen pill disagree on file-less proposals; ancestor-is-a-file paths 500 instead of 409 | ready | S |

## Current state — picking this up fresh (2026-08-03)

Branch **`epic-012-folders`**, two commits ahead of `main`, nothing pushed and
no PR opened yet:

| Commit | Story |
|---|---|
| `5a455ed` | 012-002 — move is a first-class, identity-preserving event |
| `63f2755` | 012-001 — folder tree UI (code complete, browser check pending) |

Green as of that commit: `agent-backend` 396 tests pass (35 files), and
`webapp` `npx tsc --noEmit` + `npm run build` are both clean.

**The one thing blocking 012-001 from `done`** is that `tree-check.mjs` has
never been run. It needs the backend and webapp both up, and it writes into a
real project (it takes `projects[0]` unless `PROJECT_ID` is set), so it has
purge-on-startup and try/finally cleanup — but check the diff before trusting
it with a workspace you care about:

```bash
cd agent-backend && npm run dev     # terminal 1, port 3002
cd webapp && npm run dev            # terminal 2, port 5174 (pinned)
cd webapp && npm run tree-check     # terminal 3
```

Until that passes, three of 012-001's acceptance criteria are built but not
demonstrated, and the story record says so explicitly.

**If you are refining specs, start here** — these are the places where the
build made a judgment call that a fresh reading might want to revisit:

- **012-001 AC 4 was restated, not met as written.** The folder rollup and the
  header pill count genuinely different things and cannot agree; the divergence
  is 012-005. Decide which is the truth before building more badge behaviour.
- **012-001's "agent-created files land in the selected folder"** shipped as a
  *prompt hint*, restricted to `draft/`, not as enforcement. If the intent was
  enforcement, that is a runtime change to the agent file tools and belongs in
  its own story.
- **012-002 deliberately kept `path` as identity** and added no file-id column.
  Every later feature that wants a stable handle for a file (external links,
  for instance) reopens that decision — the reasoning is in that story's Notes.
- **012-004 and 012-005 were both filed from review findings**, not from
  product intent. Confirm they are worth doing before scheduling them.

## Sequencing

**Decided at kickoff:** 002 ships first, so 001 can enable move with no
orphaning caveat and no warning banner to remove later. 002 is the substance
and is now done. 001 is next; 003 is a verification sweep more than a build.
004 collects the two client-side gaps 002 shipped with.

## Risks

- **Move-while-open collab** — two clients with the doc open during a move is
  the same class of hazard as the restart-merge two-tab problem; 002 must
  evict-and-redirect atomically (close old room with a redirect code, client
  rejoins new path) and test it at the websocket level.
- **Path assumptions in the webapp** — flat-list assumptions may lurk in
  files.ts/preview/citation pickers; budget a sweep, not spot fixes.
