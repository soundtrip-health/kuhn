# Story 010-002: Server-side Yjs persistence

**Status:** draft
**Epic:** [010 — Collaboration & Org Readiness](../index.md)
**Estimate:** L

## Goal

Collab rooms survive backend restarts, and the client-side seeding dance
disappears. Today rooms are memory-only (`yjs-websocket.js` says "persistence
can be added later" — this is later): a restart mid-edit loses un-autosaved
CRDT state, and stories 038/041 had to build eviction, a seed-grant message,
and a seeder-death fallback to keep client seeding honest.

**Observed in the wild (2026-07-19, during 008-002 verification):** two tabs
held the same document across several `node --watch` restarts; each restart
destroyed the room, both clients auto-reconnected and re-pushed local CRDTs
that had been seeded independently, and the merge **duplicated the entire
document** (main.md doubled to exactly 2× and the doubled state was
autosaved to storage; recovered by de-duplicating the identical halves).
Server-persisted rooms make reconnection converge on stored truth and this
class of corruption impossible — treat that repro as this story's
regression test.

## Sketch

- **Update log per room** in SQLite (`yjs_updates`: room, seq, update blob),
  appended on every doc update; on room creation, load and apply the log.
  Periodic compaction (encode current state as one update, drop the log tail)
  keeps it bounded. better-sqlite3 is synchronous and in-process — same
  durability story as the rest of the DB.
- **Seeding moves server-side:** a room whose log is empty is seeded once,
  on creation, from the stored markdown — requires a server-side
  markdown→ProseMirror-Y.Doc conversion sharing the webapp's schema
  (citation node included). This is the hard part: extract the schema
  definition into a shared package/module both sides import, and build the
  Y.Doc via `prosemirrorToYDoc` on the backend.
- **Retires 041 machinery:** with server seeding, the seed-grant message,
  client `applyTemplate`, and the seeder-death fallback go away; eviction
  (038) simplifies to "delete room rows + close conns" with no repopulation
  hazard (a reconnecting stale client syncs against persisted truth).
- **Reconciliation:** storage (markdown) remains the export/render source of
  truth via editor saves, unchanged. Divergence detection (room vs stored
  bytes) logs loudly rather than silently preferring either.

## Acceptance Criteria

- [ ] Kill the backend mid-edit, restart: the reconnected editor has every
      keystroke, including those inside the autosave debounce window.
- [ ] Deleting a file purges its room rows; the 038 repro (delete →
      re-upload same name) still shows the new content.
- [ ] Two clients opening an unseeded document concurrently get exactly one
      copy — now guaranteed server-side; the client grant/fallback code and
      its tests are removed or superseded deliberately (story record says
      which).
- [ ] Update log growth is bounded by compaction; DB size impact measured
      and noted.
- [ ] `docs/data-pipeline.md` §ephemeral-state updated: live collab state is
      now persisted; state what changed.

## Notes

- The schema-sharing prerequisite is real work — do not fork the schema
  definition (a drifted server schema corrupts docs silently).
- 008-002 (version history) is unaffected: it snapshots storage, not rooms.
