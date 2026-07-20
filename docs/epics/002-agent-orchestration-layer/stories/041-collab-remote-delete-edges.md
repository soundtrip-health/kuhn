# Story 041: Remote delete/replace with live collaborators — remaining edges

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Story 038 fixed the single-user stale-room bug (delete → re-upload same name).
Three multi-client edges remain; this story owns them (038 is read-only).

1. **Remote delete leaves other tabs' editors open.** The deleting tab drops
   its own document (`dropOpenDoc`), but another tab with the same doc open
   only runs `applyExternalChange`, which treats the 404 as "nothing to apply"
   and leaves the dead document on screen. It should close/discard the editor
   (or clearly mark the doc as deleted) when a `file_change` delete arrives
   for the open path.
2. **An evicted live client can repopulate the room from its local CRDT.**
   On `kind: 'delete'` the server closes live sockets (4001), but
   y-websocket auto-reconnects and the client's local Y doc state re-seeds
   the fresh room with the deleted content. Needs either a client that treats
   close-code 4001 as "do not reconnect with state" (destroy provider + ydoc
   on 4001), or a server-side rejection of sync-step-2 into a brand-new room
   from a pre-eviction client.
3. **Concurrent template-seed race.** Two clients opening the same empty room
   simultaneously can both pass the "room is empty" check and both
   `applyTemplate`, duplicating the document. Low likelihood; needs either a
   server-seeded room or a deterministic client tiebreak.

## Acceptance Criteria

- [ ] A `file_change` delete for the open document closes/discards it in
      every connected tab, not just the deleting one.
- [ ] After a server-side eviction (close 4001), a stale client cannot
      repopulate the new room with pre-eviction content.
- [ ] Two clients racing to open an unseeded document produce one copy of the
      template, not two.

## Notes

- Origin: 038's fix review (2026-07-19). None of these are regressions — all
  predate 038; the eviction work just made them visible.
- The cleanest long-term shape is probably server-side seeding/persistence of
  Yjs rooms (the "persistence can be added later" note in `yjs-websocket.js`),
  which would collapse edges 2 and 3 into one mechanism.
