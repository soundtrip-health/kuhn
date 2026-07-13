# Story 003: Yjs room authorization

**Status:** ready
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** M

## Goal

Close the long-standing hole: anyone who can reach the WebSocket port can
join any Yjs room by guessing/knowing a doc id — no membership check exists
on `/yjs-websocket/<room>` or `/yjs-signaling`. Flagged in Epic 002 story 018
and Epic 004 story 002 ("do not expose beyond trusted test users") but never
given an owning open story; this is it.

## Acceptance Criteria

- [ ] Joining room `project-<id>/<path>` requires the requester to be a
      member of that project's org. Mechanism: authenticate the WS upgrade
      via the Story 002 session cookie, or a short-lived room token minted by
      an authenticated REST call (`POST /api/projects/:id/collab-token`) and
      passed in the WS URL — choose whichever the Story 002 session shape
      makes cleaner and document the choice here on completion.
- [ ] Unauthorized joins are refused at upgrade or first message —
      the socket closes before any doc sync bytes flow.
- [ ] Room names are parsed and validated server-side (project id extracted,
      path sanity-checked) — a malformed room name cannot bypass the check.
- [ ] `/yjs-signaling` gets the same gate (it currently relays for WebRTC
      fallback).
- [ ] Dev mode (`KUHN_AUTH_MODE=dev`) keeps the current frictionless behavior
      so `editor-check`/`parity-check`/collab scripts run unchanged.
- [ ] The webapp's `WebsocketProvider` setup (`editor.ts:294-296`) passes the
      credential; reconnect-after-reload (story 024/028 behavior) still works.
- [ ] Vitest coverage: member joins, non-member refused, malformed room
      refused, expired room token refused (if token approach chosen).

## Notes

- Files: `yjs-websocket.js`, `yjs-signaling.js`, `index.js:35-49` (upgrade
  routing), possibly `routes/projects.js` (token mint), `webapp/src/editor.ts`.
- Depends on Story 002 for a verifiable session at upgrade time.
- Doc persistence for Yjs (currently in-memory only, `yjs-websocket.js:6-9`)
  remains out of scope — different problem, file separately if it bites.
