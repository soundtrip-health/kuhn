# Story 013: Webapp Scaffold (Single App, Milkdown Editor)

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Scaffold the Kuhn webapp as a **single application**: agent chat panel, Milkdown WYSIWYG
markdown editor, and a file-manager shell, talking to the agent backend. Supersedes the
"separate vanilla-JS agent workspace + TeXlyre" plan.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ Kuhn  [project-name]                                  [?] │
├──────────────┬───────────────────────────┬───────────────┤
│  Agent Chat  │     Milkdown Editor       │  Files        │
│  (PM et al.) │     (draft/main.md)       │  (tree,       │
│  streaming   │     WYSIWYG markdown      │   upload,     │
│  messages    │     /commands             │   preview)    │
├──────────────┴───────────────────────────┴───────────────┤
│  status bar: render state, agent activity, token usage   │
└──────────────────────────────────────────────────────────┘
```

Chat and Files panels are collapsible; editor is the primary surface.

## Acceptance Criteria

- [ ] `webapp/` at repo root: Vite + TypeScript, no UI framework (plain TS + DOM; revisit only
      if it becomes painful)
- [ ] Milkdown editor renders and edits a markdown document (commonmark + GFM presets; math
      plugin for `$...$`)
- [ ] Document loads from and saves to the backend storage API (`draft/main.md` of the active
      project)
- [ ] Chat panel: send a message, stream the agent's response (story 011 events), render
      markdown in replies, tag messages with agent role
- [ ] Decide on streaming granularity: story 011 delivers per-assistant-turn text events
      over SSE; if the chat needs token-level streaming, enable the SDK's
      `includePartialMessages` in the runtime and map `stream_event` deltas to a new
      `text_delta` AgentEvent (deferred from story 011)
- [ ] File panel shell: list project tree from backend (full manager is story 014)
- [ ] Yjs wiring: editor binds to the existing y-websocket server room for the document
      (single-user is fine; this just proves the collab path)
- [ ] `npm run dev` serves the app; backend CORS updated for the webapp origin

## Technical Notes

- Milkdown packages: `@milkdown/kit` (core, commonmark, gfm, math, history, clipboard),
  `@milkdown/plugin-collab` for Yjs. Verify current package layout at implementation time.
- Keep editor state ↔ backend sync simple for the prototype: save on debounce + explicit save;
  Yjs is the collab/transport layer, storage API is persistence.
- The retired `texlyre/` fork is reference material for editor UX (toolbar, preview split) —
  do not import code from it (AGPL); reimplement.

## Out of Scope

- Slash commands (story 016)
- PDF preview / export (story 019)
- File upload/preview details (story 014)
- Auth, multi-project switching UI polish
