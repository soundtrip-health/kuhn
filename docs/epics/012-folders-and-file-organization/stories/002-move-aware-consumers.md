# Story 012-002: Move-aware path consumers

**Status:** done
**Epic:** [012 — Folders & File Organization](../index.md)
**Estimate:** L

## Goal

A move must carry a file's identity with it. Today `moveProjectEntry` emits
a delete+create pair, which orphans everything keyed by path: comment
threads stay on the old path, a live Yjs room keeps its old name, pending
edits and unresolved badges point nowhere. Make `moved` a first-class event
and update every path consumer transactionally.

## Sketch

- **Event model:** new `file_events` kind `moved` with `path` = new,
  `meta.from` = old (replaces the delete+create pair for renames/moves; the
  agent `move_file` tool emits the same). Feed UI renders "moved A → B".
- **DB consumers, same transaction as the event write:**
  - `comments.path` — `UPDATE ... SET path = replace(prefix)` for the moved
    file or every descendant of a moved folder
  - pending edits and any other path-keyed rows (audit `schema.sql` for
    `path` columns; enumerate the list in this story record)
  - seen-state already follows; fold it into the same helper
- **Yjs rooms:** on move of an open doc, evict the old room with a dedicated
  close code (e.g. 4002 + new path in the reason) so connected clients
  rejoin the new room and reseed from storage — same pattern as the 038
  delete-eviction, plus client-side rejoin handling in the collab bootstrap.
  Room content is storage-seeded, so no Yjs state migration is needed —
  clients must simply save-then-rejoin without data loss.
- **Webapp:** open editor tabs/preview retarget on the `moved` event
  (project feed SSE already delivers events live); cite-picker/file pickers
  refresh.
- Folder moves are prefix rewrites of all of the above; do them in one
  storage rename (already atomic at the fs level) + one DB transaction.

## Acceptance Criteria

- [x] Moving a file preserves its comment threads, unresolved badges, and
      pending edits under the new path (assert rows updated, none orphaned).
- [x] Moving a folder updates all descendants' consumers in one transaction.
- [x] Two clients with the doc open during a move both land in the new room
      with identical content and no duplicate-doc merge (websocket-level
      test; see the restart-merge hazard in docs/data-pipeline.md).
- [x] The feed shows a single `moved` entry, not delete+create; agent
      `move_file` produces the same.
- [x] Old-path requests after a move 404 cleanly (no half-alive state).

## Notes

- Deliberately **no file-id column**: storage remains the source of truth
  and path remains identity; move becomes a tracked identity-preserving
  operation instead. If a future feature needs stable ids (external links to
  files), revisit then.

## What shipped

`moved` is a first-class event kind. `publishProjectEvent` is the single seam:
a `moved` file_change routes to `applyMove()` (`db/move-paths.js`) instead of
`recordFileEvent`, so every path-keyed rewrite and the activity row share one
transaction. Both producers — `POST /files/move` and the agent `move_file`
tool — publish one event and no longer call `migrateSeenPaths` themselves.

**Event shape** — `{ type:'file_change', kind:'moved', path:<NEW>, meta:{ from:<OLD> } }`.
`path` is always the new path so existing `event.path` consumers keep working.
A folder move emits exactly **one** event; descendants are implied by prefix.

### schema.sql path-column audit

The story asked for this list to be enumerated. `db/move-paths.js` carries it
as a header comment (kept next to the code that acts on it); in summary:

| Column | Treatment |
|---|---|
| `file_seen.path` | rewritten (via `migrateSeenPaths`, now called inside the transaction) |
| `comments.path` | rewritten — roots **and** replies (`addReply` copies `root.path`) |
| `pending_edits.path` | rewritten, with a pre-check for the `UNIQUE(project_id, path)` clash |
| `projects.config` → `activeDocument` | rewritten when it points at the moved path |
| `file_events.path` | **appended to, never rewritten** — the log is history; the move adds one `moved` row |
| `projects.root_path` | untouched — the workspace root, not a file path |
| `org_documents.filename`, `org_document_chunks.heading_path` | untouched — org scope / heading trail, not project paths |
| `jobs.input`/`context`, `messages.tool_calls` | untouched — rewriting free-form transcript prose would falsify it |

### Decisions taken at build time

- **`moved` as a new kind, not the dormant `rename`.** Adding it to the
  `file_events` CHECK needs a table rebuild (SQLite cannot `ALTER` a CHECK).
  `applyFileEventsKindMigration()` does the documented 12-step ALTER —
  crucially with `foreign_keys` toggled **off outside** the transaction, since
  `file_events` has three *outbound* FKs that SQLite re-validates on every
  copied row. **Deploy note:** it throws if `PRAGMA foreign_key_check` reports
  violations afterwards, and `initDb()` does not catch — the backend will
  refuse to start on a DB with pre-existing FK violations in `file_events`.
  That is deliberate (fail loudly), but it is a startup-blocking condition.
- **Close code 4002** carries the new path in the WS close reason. Reasons cap
  at 123 UTF-8 bytes; over that the server sends 4002 with an **empty** reason
  and the client enters an explicit "moved — reload" state rather than guessing.
  The reason is computed **per room**, so each descendant of a folder move is
  told its own new path, not the folder's.
- **Canonical paths are storage's, not the caller's.** `moveProjectEntry` now
  returns the `{from, to}` it actually operated on; producers publish those.
  `./a.md`, `a//b` and `dir/` all rename fine on disk but would key the prefix
  rewrite to a path matching zero rows.
- **Path identity is byte-exact.** The self-move guard compares resolved
  absolute paths, so on case-insensitive APFS a case-only rename
  (`draft/Main.md` → `draft/main.md`) is *not* a self-move and proceeds. Rows
  keyed `Draft/…` will not match a request for `draft/…`.
- **Failure contract.** `moved` is the one kind whose persistence failure is
  **not** swallowed: it propagates so the producer can compensate by renaming
  back. The route returns 409 on a destination file *or* a destination pending
  edit, 400 on self-move / folder-into-own-descendant, and 500
  `inconsistent_state` only when the compensating rename also fails.
- **Pending edits follow their file, and are re-checked at accept time.**
  A move can carry a proposal out of `draft/**`, a scope it could never have
  been created in, so `acceptEdit` now re-checks `isSuggestionPath` before
  writing rather than trusting the row.

### Also fixed here (found by review, belonged to this change)

- `moveProjectEntry` let you move a folder into its own descendant: it reached
  `rename(2)`, failed `EINVAL` (not a `StorageError`, so a **500**), and left
  behind the directories `mkdir -p` had already created. Now a proper
  `invalid_path` 400 — which is also an acceptance criterion of [012-001](001-folder-tree-ui.md).
- `renameEntry` tested `node.path === activePath` exactly, so renaming a
  *folder* never flushed an open descendant document before the server evicted
  its room — and rooms are memory-only, so those keystrokes were the only copy.

## Known gaps (owned by open stories)

- A client that **ignores** close 4002 resurrects the old room — there is no
  server-side tombstone. Characterised by the `KNOWN GAP` case in
  `move-collab.test.js`; the containment that *does* hold is asserted there
  (the resurrected room is a separate room, so stale edits cannot reach or
  duplicate into the moved document). Owned by [012-004](004-move-hardening.md).
- No webapp-level test drives the client `moved` handler — the webapp has no
  vitest setup at all. Owned by [012-004](004-move-hardening.md).
- `bib.ts:8` and `main.ts:51` hard-code `draft/references.bib` and
  `draft/main.md`; a folder move makes those reachable. Owned by
  [012-001](001-folder-tree-ui.md).
- `FilesHandlers.reopenOpenDoc` is now dead (zero call sites) — the SSE `moved`
  event is the single retarget path. Cleanup owned by [012-001](001-folder-tree-ui.md).
