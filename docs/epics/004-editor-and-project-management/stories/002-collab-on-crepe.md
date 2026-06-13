# Story 002: Collaboration on Crepe

**Status:** done
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** M

## Goal

Restore real-time collaboration on the new Crepe editor (Story 001). Crepe does
not bundle Yjs, so port the existing `@milkdown/plugin-collab` binding onto
Crepe's underlying Milkdown editor (`crepe.editor`): the per-document
y-websocket room, seed-from-storage-when-the-room-is-empty logic, and awareness.
Carry over the story-024 reload-race fix.

## Acceptance Criteria

- [x] `@milkdown/plugin-collab` is added to `crepe.editor` and bound to a
      `WebsocketProvider` against `${BACKEND_WS_URL}/yjs-websocket`, reusing the
      existing `roomName(projectId, path)` (`project-{id}/{path}`).
- [x] Two browser tabs editing the same document converge in real time.
- [x] Seed-on-empty behavior is preserved: the shared doc is seeded from storage
      (`applyTemplate`) only when the room is empty; otherwise live state wins.
- [x] The story-024 fix carries over: collab is detached
      (`collabServiceCtx.disconnect()`) before `editor.destroy()`, and the
      `sync` handler bails if the document was switched before sync arrived — no
      `editorState` ctx error on reload with a warm room.
- [x] Switching documents tears down the provider/ydoc cleanly (no late
      awareness events dispatching into a destroyed view).

## Acceptance Criteria — risk gate

- [x] **Spike first:** confirm `@milkdown/plugin-collab` mounts on a
      `CrepeBuilder` editor before building the full path. If incompatible, fall
      back to a thin custom collab layer over `crepe.editor` and note it here.

## Notes

- Source to port: `editor.ts:211-224` (collab bind + provider + seed-on-sync) and
  `editor.ts:227-239` (`closeDocument` teardown order). The ordering and the
  `provider !== boundProvider` guard are the story-024 fix — preserve them
  exactly.
- Crepe's `create()` is async and may initialize features in a different order
  than the old `Editor.make()` chain; verify the collab service ctx
  (`collabServiceCtx`) is available at the point we call `editor.action(...)`.
- Depends on Story 001 (needs `crepe.editor`). This is the epic's top technical
  risk — see Epic 004 Risks.
- Yjs room authorization remains deferred (Epic 002 carry-over) — do not expose
  beyond trusted test users.

## Delivery

Collab ported onto `crepe.editor` as part of the bundled editor PR (branch
`epic-004-crepe-editor`).

- `@milkdown/plugin-collab` is attached via a custom Crepe feature
  (`editor.use(collab)`); the `WebsocketProvider`, `roomName`, seed-on-empty
  (`applyTemplate`), and the story-024 teardown order + `provider !==
  boundProvider` sync guard are preserved exactly from the prior implementation.
- Risk gate: `@milkdown/plugin-collab` mounts cleanly on `CrepeBuilder` — no
  fallback layer needed. `collabServiceCtx` is available at `editor.action(...)`
  after `create()`.
- Verified: `collab-check.mjs` (two tabs converge in real time) passes on Crepe.
