# Story 003: Live file manager UX

**Status:** done
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** L

## Outcome

All acceptance criteria met (2026-07-12). The file manager is now
server-backed and live:

- **Hydration**: `refreshTree` fetches the tree (per-user `unseen` flags,
  `mtime`) and the activity log in parallel and rebuilds the status/origin
  maps from server truth — badges survive reload and project switches. The
  in-memory maps are now a cache, not the source of truth. Origin tint
  prefers recorded `agent_slug` (kept even after a badge clears); the
  extension guess remains only as fallback.
- **Feed subscription**: one `EventSource` on
  `GET /api/projects/:id/events` per active project (auto-reconnect for
  free), torn down on switch with the `switchSeq` guard. Verified live that
  an upload from *outside* the tab produces a badge with no reload.
- **Reconciliation**: a single `handleFileChange` serves both channels; the
  job-stream side-effects stand down while the feed is open (`feedOpen`
  gate), and `refreshTreeSoon` coalesces bursts/double deliveries (250 ms).
- **Seen**: opening a file (editor or preview) clears its badge in place and
  POSTs seen state (throttled per path); an agent update applied cleanly to
  the open document is auto-marked seen — it's on screen.
- **Chrome**: unseen-count pill on the Files toggle (with `aria-label`),
  refresh button in the files header, loading dim + first-load notice, and a
  retryable error state. `mtime` shown in the row tooltip.

Verified: `npm run build` clean; **files-check extended** (hydrated badge,
pill, click-clears-badge, server-persisted seen, activity log, unseen/mtime
in tree — 19/19 ok) plus a live external-change probe (badge appears via the
feed with no reload) and `editor-check` (no regression). Playwright chromium
was reinstalled locally (cache had been invalidated by a version bump).

## Goal

Wire the file manager to the server-side activity model: badges hydrate from
the backend on load, update live from the project event feed, clear when the
user opens a file, and an unseen count shows on the Files toggle. The existing
badge renderer and CSS (`webapp/src/files.ts:458-485`, `style.css:677-714`)
are kept — this story replaces where their *data* comes from.

## Acceptance Criteria

- [x] On project open, the tree renders unseen/origin state from the Story 002
      tree payload — badges survive reload and project switch. The in-memory
      `statusMap` becomes a cache of server state, not the source of truth.
- [x] The webapp opens one `GET /api/projects/:id/events` subscription per
      active project (Story 001), torn down on project switch (respect the
      existing `switchSeq` race guard in `main.ts`). Incoming `file_change`
      events update badges and refresh affected tree nodes — including events
      from jobs this tab did not launch (verify: reload mid-job; badges appear
      when the job's writes land).
- [x] Opening a file marks it seen (`POST …/files/seen`, debounced) and clears
      its badge. Renames carry state per Story 002.
- [x] The Files toggle button (`index.html:30`) shows an unseen-count pill;
      count updates live and zeroes as files are viewed.
- [x] A refresh button in the files header re-fetches the tree; the tree shows
      a loading state during fetch and a retryable error state on failure
      (today: nothing during fetch, `files.ts:163-172`).
- [x] `mtime` surfaced per file (tooltip or muted inline text).
- [x] Origin tint uses recorded `agent_slug` when present; the extension-based
      guess (`files.ts:496-501`) remains only as fallback for legacy files.
- [x] The job-scoped SSE `file_change` handling (`chat.ts:212-220`,
      `main.ts:115-129`) is reconciled with the feed so events aren't
      double-applied.
- [x] `webapp` token-free check scripts still pass; extend `files-check` (or
      add one) to cover hydrate → live-event → mark-seen.

## Notes

- Files: `webapp/src/files.ts`, `api.ts` (feed client + new endpoints),
  `main.ts` (subscription lifecycle), `chat.ts` (dedupe), `index.html`,
  `style.css` (count pill).
- Keep the feed subscription resilient: auto-reconnect with backoff on drop
  (mirrors the story-028 reconnect-on-reload pattern).
- The `ingesting`/`done` badge states stay dormant until Epic 006's ingestion
  pipeline emits them — do not remove them.
