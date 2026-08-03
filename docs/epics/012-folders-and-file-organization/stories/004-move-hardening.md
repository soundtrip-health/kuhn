# Story 012-004: Move hardening — room tombstones & client-side move tests

**Status:** ready
**Epic:** [012 — Folders & File Organization](../index.md)
**Estimate:** S

## Goal

Close the two gaps [012-002](002-move-aware-consumers.md) shipped with, both
of them on the collab/client side of a move. Neither corrupts data today —
012-002 asserts the containment that holds — but both leave a stale tab in a
state the server cannot correct.

## The gaps

### 1. No tombstone for a moved room

`handleYjsConnection`'s `getOrCreateDoc` recreates any room name on demand, so
a client that **ignores** close code 4002 simply reconnects to the old room and
re-uploads its state. y-websocket reconnects on *any* close code unless
`disconnect()` is called, so this is the default behaviour of any tab that
predates 012-002 — and of any future client that forgets the 4002 branch.

What already holds (asserted by the `KNOWN GAP` case in `move-collab.test.js`):
the resurrected room is a *separate* room, so nothing written there can reach
or duplicate into the moved document. The harm is confined to the stale tab
silently editing a ghost.

Fix: a short-lived tombstone in `yjs-websocket.js` — a moved room name refuses
the join (or immediately closes it 4002 with the new path) for a grace window,
rather than being recreated empty. `move-collab.test.js`'s `KNOWN GAP` case is
the receiving test; it should flip from characterising the behaviour to
asserting the guarantee.

### 2. No client-side test for the `moved` handler

The webapp has **no vitest setup at all** — only token-free `scripts/*.mjs`
checks. So `editor.ts`'s 4002 branch (`followMovedRoom`) and `main.ts`'s
`moved` handler are covered only by emulation in a backend test, which by
construction cannot fail for the client-side interleavings the 012-002 review
raised (autosave debounce firing between rename and event; SSE arriving before
or after the WS close; the mover's own tab receiving its own event mid-request).

Fix: stand up vitest in `webapp/` and unit-test the `moved` handler directly.
Standing up the harness is most of the work; the tests are small.

## Acceptance Criteria

- [ ] A client that reconnects to a moved room name does not get a live empty
      room — it is refused or immediately closed with 4002 + the new path.
- [ ] The tombstone expires, so a path legitimately re-created at the old name
      later (a new file, or a move back) opens normally.
- [ ] `move-collab.test.js`'s `KNOWN GAP` case asserts the guarantee rather
      than characterising the gap, and is renamed accordingly.
- [ ] `webapp/` has a vitest setup with the `moved` handler covered: clean
      retarget, dirty retarget (flush → fresh Y.Doc → rejoin), 4002 with an
      empty reason → "moved — reload" state, and a missing `meta.from`.

## Notes

- Keep the tombstone in memory alongside `docs`; it does not need persistence.
  A restart already drops every room, and a restarted server has no stale
  client state to protect against beyond what story 038 already handles.
- Related hazard worth re-reading before starting: the restart-merge /
  duplicate-doc problem in `docs/data-pipeline.md`. The reason 012-002 is safe
  is that clients build a **fresh `Y.Doc` per room join** and never mutate
  `provider.roomname` — any fix here must preserve that.
