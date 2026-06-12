# Story 024: Collab Plugin Reload Race (`editorState` Context Error)

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Problem

Reloading the webapp while the document's Yjs room is still warm (a room lives for 30 s
after the last client disconnects — `agent-backend/src/yjs-websocket.js`) throws an
uncaught error in the browser console:

```
MilkdownError: Context "editorState" not found, do you forget to inject it?
    at Plugin.apply …
    at EditorView.dispatch …
    at @milkdown/plugin-collab (provider sync handler)
```

Reproduce: open http://localhost:5174, wait for sync, reload the page, watch the console.
Found during story 016 verification; reproduced on main with story-016 code stashed, so it
pre-exists the slash-command work.

## Diagnosis (starting point)

The y-websocket provider connects and delivers sync updates while the Milkdown editor is
mid-create or mid-destroy: `@milkdown/plugin-collab` dispatches a ProseMirror transaction
into a view whose Milkdown ctx does not (yet/anymore) hold `editorState`. Two suspect
windows in `webapp/src/editor.ts`:

1. `openDocument` binds the provider and calls `applyTemplate(...).connect()` inside
   `provider.once('sync')` — a fast sync (same-process server, warm room) can race the
   remainder of editor creation.
2. `closeDocument` (run from `beforeunload`) awaits `flushSave()` before destroying the
   provider, so during unload the provider can deliver updates to a partially destroyed
   editor.

## Acceptance Criteria

- [ ] Reload with a warm room produces no console errors (verify with a scripted check —
      reuse the reload steps in `webapp/scripts/cite-check.mjs` or a dedicated script)
- [ ] Collaboration still works after the fix (two tabs sync; `scripts/collab-check.mjs`
      passes)
- [ ] No lost edits on reload: content typed immediately before reload survives
