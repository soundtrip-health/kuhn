# Story 012-002: Move-aware path consumers

**Status:** ready
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

- [ ] Moving a file preserves its comment threads, unresolved badges, and
      pending edits under the new path (assert rows updated, none orphaned).
- [ ] Moving a folder updates all descendants' consumers in one transaction.
- [ ] Two clients with the doc open during a move both land in the new room
      with identical content and no duplicate-doc merge (websocket-level
      test; see the restart-merge hazard in docs/data-pipeline.md).
- [ ] The feed shows a single `moved` entry, not delete+create; agent
      `move_file` produces the same.
- [ ] Old-path requests after a move 404 cleanly (no half-alive state).

## Notes

- Deliberately **no file-id column**: storage remains the source of truth
  and path remains identity; move becomes a tracked identity-preserving
  operation instead. If a future feature needs stable ids (external links to
  files), revisit then.
