# Story 013: Webapp Scaffold (Single App, Milkdown Editor)

**Status:** done
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

- [x] `webapp/` at repo root: Vite + TypeScript, no UI framework (plain TS + DOM; revisit only
      if it becomes painful)
- [x] Milkdown editor renders and edits a markdown document (commonmark + GFM presets; math
      plugin for `$...$`)
- [x] Document loads from and saves to the backend storage API (`draft/main.md` of the active
      project)
- [x] Chat panel: send a message, stream the agent's response (story 011 events), render
      markdown in replies, tag messages with agent role
- [x] Decide on streaming granularity: **decided token-level** — `includePartialMessages`
      enabled in the runtime; `stream_event` text deltas map to a new `text_delta`
      AgentEvent, with the per-turn `text` event still finalizing each turn
- [x] File panel shell: list project tree from backend (full manager is story 014)
- [x] Yjs wiring: editor binds to the existing y-websocket server room for the document
      (single-user is fine; this just proves the collab path)
- [x] `npm run dev` serves the app; backend CORS updated for the webapp origin

## Implementation Notes (2026-06-11)

- `webapp/`: Vite + TS, plain DOM. `src/api.ts` (backend client + SSE parser),
  `src/editor.ts` (Milkdown via `@milkdown/kit`, nord theme, collab plugin),
  `src/chat.ts`, `src/files.ts`, `src/status.ts`. Dev server pinned to **5174**
  (5173 routinely collides with other local apps); backend CORS is a comma-separated
  allowlist covering it.
- Editor persistence: debounced (1.5 s) + Cmd/Ctrl+S write-through to the storage API;
  Yjs is transport only. On an empty Yjs room the document seeds from storage via
  `collabService.applyTemplate`.
- Chat keeps one SDK session per role (`done.sessionId` → next request), so follow-up
  messages continue the conversation.
- Backend additions: `GET/POST /api/projects` (webapp bootstraps a demo project through
  the API when the DB is empty).
- Verified by browser smoke tests (`webapp/scripts/`, `npm run smoke`, `npm run smoke:chat`):
  load → edit → debounced save persists via the API; two-page Yjs sync; live agent
  round-trip with streamed deltas and token usage in the status bar.
- **Latent bugs found and fixed while wiring the webapp:**
  - The y-websocket server (story 009) never broadcast doc updates to other
    connections — single-client use had masked it. Added the `doc.on('update')` relay.
  - The SSE route (story 011) cancelled tasks via `req.on('close')`, which in Node 13+
    fires once the request body is consumed — the server killed its own agent tasks
    right after the first event. Moved to `res.on('close')`. (Story 011's smoke test
    calls `runAgentTask` directly, so the HTTP path was never exercised.)

## Known Issues

- Agent replies render through `marked` without sanitization; acceptable for the trusted
  single-user prototype, must be revisited with multi-user/auth (epic Deferred list).
- Agent edits to the open document don't live-update the editor (agents write via the
  storage API, not Yjs); the status bar prompts a reload instead. Proper wiring is part
  of story 017 (`/write` streaming edits).

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
