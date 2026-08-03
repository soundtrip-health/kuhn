# Story 012-004: Move hardening — room tombstones & client-side move tests

**Status:** done
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

- [x] A client that reconnects to a moved room name does not get a live empty
      room — it is refused or immediately closed with 4002 + the new path.
- [x] The tombstone expires, so a path legitimately re-created at the old name
      later (a new file, or a move back) opens normally.
- [x] `move-collab.test.js`'s `KNOWN GAP` case asserts the guarantee rather
      than characterising the gap, and is renamed accordingly.
- [x] `webapp/` has a vitest setup with the `moved` handler covered: clean
      retarget, dirty retarget (flush → fresh Y.Doc → rejoin), 4002 with an
      empty reason → "moved — reload" state, and a missing `meta.from`.
- [x] Deferred from [012-001](001-folder-tree-ui.md): a **rename racing an
      agent write** — the one folder-UI interaction `tree-check` could not
      demonstrate token-free. Cover the interleaving in the vitest suite (an
      agent `file_change`/proposal event arriving between the rename request
      and its `moved` event must not resurrect the old path or mis-target the
      proposal badge).

## What shipped (2026-08-03)

### 1. Move tombstones (`yjs-websocket.js` + `project-events.js`)

`plantMoveTombstone(oldPrefix, to)` is called at the same `project-events.js`
choke point as the eviction; `handleYjsConnection` checks tombstones before
`getOrCreateDoc` and bounces covered joins with the identical 4002 + new-path
verdict the eviction gave, so the compliant client path is one code path.

Two deliberate upgrades over the sketch:

- **Prefix-based, not per-room.** A folder move re-keys descendant paths whose
  rooms may not be live at eviction time — there is nothing to enumerate. A
  prefix tombstone computes each bounced room's own destination with the same
  arithmetic as the eviction's per-room close reason (tested: a descendant
  with no live room, bounced with its own new path).
- **Expiry is memory hygiene, not the correctness boundary.** A path made
  legitimately live again is cleared *immediately*: a move back clears the
  destination's tombstones (`plantMoveTombstone` does it), and any other file
  event at a tombstoned path clears it (`clearMoveTombstonesUnder` in the
  non-move branch of the hub). The 5-minute TTL only reaps entries nothing
  ever touched again. Chained moves inside the window (a→b→c) resolve by
  hopping — each bounce carries the next destination.

In-memory on purpose (per the sketch): a restart drops every room anyway.
Backend tests: `move-collab.test.js` — the former `KNOWN GAP` case now asserts
the bounce (no room comes into being, no seed grant, new room unaffected),
plus idle-descendant bounce, move-back, create-at-old-name, and expiry.
Suite: 404 tests green.

### 2. Webapp vitest + the `moved` handler tests

`vitest` is a webapp devDependency now (`npm test` / `npm run test:watch`),
running in a node environment with no DOM needed — because the tested logic
was **extracted, not mocked around**. `editor.ts`'s `followMovedRoom` and
`retargetDocument` imported the entire Milkdown stack and kept their state
module-private, which is exactly why they were untestable; their decision
logic now lives in **`src/move-follow.ts`** (`resolveMovedRoom`,
`performRetarget`, `movedDocAction`) over narrow host interfaces, and the
hosts in `editor.ts`/`main.ts` are thin adapters supplying real state. The
load-bearing rationale comments moved with the logic.

`src/move-follow.test.ts` (17 tests) covers the story's list: clean retarget,
dirty retarget (flush → reopen with the buffer as the restore payload), 4002
with an empty/stale reason → parked "moved — reload" state, missing
`meta.from` → tree-inspection fallback, both feed-vs-4002 races (path or
project changing mid-read yields to the winner), folder-move descendant
arithmetic and lookalike prefixes, and the mover's own tab receiving its own
event.

**The deferred rename-vs-agent-write race** is covered as the rule-1 ordering
test: any save racing the retarget lands on the *destination* (the fake host's
`flushSave` writes to wherever the path points at flush time — if
`setCurrentPath` were not first, the test would record a write to the dead
path). The debounce-cancel-before-first-await test pins the other half. The
proposal-badge leg needs no client test: pending edits are re-keyed
server-side in the same transaction as the move (012-002 `applyMove`), and the
client-side re-key uses the same `movedPath` arithmetic the suite covers.

### Verified live

`tree-check` (45 checks, twice), `move-check`, and `collab-check` all green
against the tombstone-enabled server — the join-path change does not disturb
normal open/seed/sync flows.

## Notes

- Keep the tombstone in memory alongside `docs`; it does not need persistence.
  A restart already drops every room, and a restarted server has no stale
  client state to protect against beyond what story 038 already handles.
- Related hazard worth re-reading before starting: the restart-merge /
  duplicate-doc problem in `docs/data-pipeline.md`. The reason 012-002 is safe
  is that clients build a **fresh `Y.Doc` per room join** and never mutate
  `provider.roomname` — any fix here must preserve that.
