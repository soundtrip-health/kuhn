# Story 003: Yjs room authorization

**Status:** done
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** M

## Goal

Close the long-standing hole: anyone who can reach the WebSocket port can
join any Yjs room by guessing/knowing a doc id — no membership check exists
on `/yjs-websocket/<room>` or `/yjs-signaling`. Flagged in Epic 002 story 018
and Epic 004 story 002 ("do not expose beyond trusted test users") but never
given an owning open story; this is it.

## Acceptance Criteria

- [x] Joining room `project-<id>/<path>` requires the requester to be a
      member of that project's org. **Chosen mechanism: the Story 002
      session cookie, read at WS upgrade time** (`src/collab-auth.js`) — no
      minted room tokens. Browsers attach the cookie to same-site WS
      handshakes automatically, so the webapp needs zero token plumbing and
      reconnects authenticate for free; `readSessionCookie()` was already
      header-shaped for this.
- [x] Unauthorized joins are refused at upgrade — the raw socket gets an
      HTTP 401 (no session) / 403 (not a member, or malformed room) and is
      destroyed before the handshake completes; no doc sync bytes flow.
- [x] Room names are parsed and validated server-side (`parseRoomName`):
      project id extracted, path refuses traversal/empty segments/
      backslash/NUL — a malformed room cannot bypass or confuse the check.
- [x] `/yjs-signaling` gets the same gate: the upgrade authenticates the
      connection; each subscribe/publish topic (topics are room names) is
      membership-checked per message with a per-connection cache —
      unauthorized topics are dropped from confirmations and never relayed.
- [x] Dev mode (`KUHN_AUTH_MODE=dev`) keeps the current frictionless
      behavior — verified live (anonymous join against the dev backend
      succeeds) and `editor-check` passes unchanged.
- [x] The webapp's `WebsocketProvider` setup passes the credential — **no
      editor.ts change needed**: the session cookie rides the same-site WS
      handshake automatically. Verified live in the browser against a
      magic-link-mode stack: sign-in → editor syncs → edit → reload →
      reconnected and state intact, no re-login.
- [x] Vitest coverage (`collab-auth.test.js`, 16 tests): member joins and
      receives sync bytes; anonymous/non-member/malformed refused at
      upgrade; signaling refuses anonymous upgrades, confirms only
      authorized topics, and relays nothing into rooms the sender can't
      join. (Expired-room-token case is N/A — token approach not chosen;
      expired *sessions* are covered by story 002's tests and apply here
      via the shared `getSessionUser`.)

## Notes

- Files: `yjs-websocket.js`, `yjs-signaling.js`, `index.js:35-49` (upgrade
  routing), possibly `routes/projects.js` (token mint), `webapp/src/editor.ts`.
- Depends on Story 002 for a verifiable session at upgrade time.
- Doc persistence for Yjs (currently in-memory only, `yjs-websocket.js:6-9`)
  remains out of scope — different problem, file separately if it bites.
