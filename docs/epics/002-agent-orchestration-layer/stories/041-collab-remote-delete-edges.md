# Story 041: Remote delete/replace with live collaborators — remaining edges

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Story 038 fixed the single-user stale-room bug (delete → re-upload same name).
Three multi-client edges remained; this story closes them.

1. **Remote delete left other tabs' editors open.** The deleting tab dropped
   its own document (`dropOpenDoc`), but another tab with the same doc open
   only ran `applyExternalChange`, which treated the 404 as "nothing to
   apply" and left the dead document on screen.
2. **An evicted live client could repopulate the room from its local CRDT.**
   On `kind: 'delete'` the server closes live sockets (4001), but
   y-websocket auto-reconnects, and the client's local Y doc state would
   re-seed the fresh room with the deleted content.
3. **Concurrent template-seed race.** Two clients opening the same unseeded
   room simultaneously could both pass the client-side "room is empty" check
   and both `applyTemplate`, duplicating the document.

## Fix

1. **Remote delete** (`main.ts` `handleFileChange`): a `file_change` delete
   for the open document now closes it like the deleting tab does — discard,
   notice, fall back to `draft/main.md` — but **only when the editor is
   clean**. A dirty editor stays open with a notice ("your unsaved edits will
   re-create it on save"): unsaved work is never clobbered, and its next save
   re-creates the file. Dirtiness comes from a new `hasUnsavedChanges()`
   export in `editor.ts` (covers both rich and source mode).
2. **No reconnect after eviction** (`editor.ts`): the provider handles
   `connection-close` and, on close code **4001** (`CLOSE_ROOM_EVICTED`,
   mirrored from `yjs-websocket.js`), calls `disconnect()` — which clears
   y-websocket's `shouldConnect` so no reconnect ever fires for that
   document. The project feed owns the UI reaction.
3. **Server-decided seeder** (`yjs-websocket.js` + `editor.ts`): the server
   sends one custom protocol message per connection (type 64,
   `MSG_SEED_GRANT`) — payload 1 iff this is the **first connection into a
   room with no content** (`conns.size === 1 && doc.share.size === 0`).
   Connection order is sequential server-side, so exactly one client is ever
   granted. Only the granted client calls `applyTemplate`; others just
   `connect()` and render the synced state. A seeder-death fallback seeds
   after 3s if the room is still empty (milkdown's own empty-doc condition
   re-checks at apply time, so the fallback can never clobber content).

## Acceptance Criteria

- [x] A `file_change` delete for the open document closes/discards it in
      every connected tab, not just the deleting one (clean editors; dirty
      editors keep local work by design). — Verified live with two Chrome
      tabs, 2026-07-19: tab B discarded, fell back to `draft/main.md`,
      notice shown.
- [x] After a server-side eviction (close 4001), the client cannot repopulate
      the new room with pre-eviction content. — Verified live: a dirty tab
      whose room was evicted made no reconnect attempts, and a subsequent
      same-name upload opened with the new content in a fresh room.
- [x] Two clients racing to open an unseeded document produce one copy of the
      template. — Grant assignment is deterministic server-side (unit test
      in `yjs-websocket.test.js`); the non-granted-client path (connect
      without template, render synced content) verified live with two tabs.

## Notes

- Protection against repopulation is at the **shipped-client** level: a
  hostile or non-webapp client could still write anything into a room — but
  such a client is already authorized to write (org membership gates the
  socket, story 007-003), so this is the same trust boundary as any file
  write, not a new hole.
- A **rename** publishes delete(old)+create(new); other tabs viewing the old
  path now fall back to the main draft rather than following the rename
  (there is no rename event kind to correlate the pair). Accepted behavior —
  the doc under the old path genuinely no longer exists; file a follow-up if
  follow-the-rename UX is wanted.
- The long-term collapse of all of this remains server-side room
  seeding/persistence (the "persistence can be added later" note in
  `yjs-websocket.js`); the grant message would then become server-internal.
