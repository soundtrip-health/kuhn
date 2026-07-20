# Story 038: Stale collab room serves a deleted file's old content

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Fix: upload a doc → delete it → upload a new version under the same filename →
the editor shows the **old** version. (Observed workaround: uploading a file
with a *different* name first made the problem disappear.)

## Root cause

The y-websocket server (`agent-backend/src/yjs-websocket.js`) holds every
collab room in an in-memory map keyed by `project-<id>/<path>`, and a room
outlives its file: after the last client disconnects, the empty room lingers
for a 30-second grace window (deliberate, so a reload can reconnect warm).
Deleting the file never touched the room. Re-uploading the same filename and
opening it inside that window reconnected to the stale room; the editor's
seeding rule ("seed from storage only when the room is empty, otherwise live
collaborative state wins" — story 013/024) then replayed the old content over
the new bytes — and the debounced autosave could even write the old content
back over the new upload. The "different filename first" workaround worked
only because it burned enough wall-clock for the 30s cleanup to fire.

## Fix

One new backend rule at the single choke point every `file_change` already
crosses (`publishProjectEvent` in `project-events.js`, the same place the
activity log persists — story 005-002):

- **`kind: 'delete'`** → evict the room and close its live sockets (code 4001).
  Publishers: UI file delete, UI/agent move (old path).
- **`kind: 'create' | 'update'`** → evict the room **only if idle** (no live
  connections — i.e. it is a stale orphan inside the grace window). A room
  with live collaborators is never touched by an overwrite; the open editor
  reconciles through the existing `file_change` feed (`applyExternalChange`).

The editor's own debounced autosave `PUT` deliberately publishes no events
(story 005-002), so normal typing never evicts anything.

`evictRoom(name, { closeConnections })` and a `hasRoom` test hook are exported
from `yjs-websocket.js`; `src/yjs-websocket.test.js` covers eviction directly
and through `publishProjectEvent`.

## Acceptance Criteria

- [x] Upload → open → delete → re-upload same filename → open (all inside 30s)
      shows the **new** content. (Verified live in Chrome, 2026-07-19: editor
      showed the new upload; storage still held the new bytes 2.5s later, so
      no autosave clobber.)
- [x] An upload that overwrites a file **currently open** in an editor does not
      kick the live connection (existing reload-prompt/live-apply behavior
      unchanged).
- [x] Agent `move_file` (which publishes delete+create) clears the old path's
      room.
- [x] Unit tests for evict-idle, evict-with-close, no-evict-live, and the
      delete/re-upload sequence.

## Notes

- Known edge cases with **live collaborators on other tabs** are out of scope
  here and owned by Story 041 (remote delete doesn't close other tabs' editors;
  an evicted live client can repopulate a room from its local CRDT on
  reconnect; concurrent template-seed race).
