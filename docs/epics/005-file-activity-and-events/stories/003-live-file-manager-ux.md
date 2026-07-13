# Story 003: Live file manager UX

**Status:** ready
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** L

## Goal

Wire the file manager to the server-side activity model: badges hydrate from
the backend on load, update live from the project event feed, clear when the
user opens a file, and an unseen count shows on the Files toggle. The existing
badge renderer and CSS (`webapp/src/files.ts:458-485`, `style.css:677-714`)
are kept — this story replaces where their *data* comes from.

## Acceptance Criteria

- [ ] On project open, the tree renders unseen/origin state from the Story 002
      tree payload — badges survive reload and project switch. The in-memory
      `statusMap` becomes a cache of server state, not the source of truth.
- [ ] The webapp opens one `GET /api/projects/:id/events` subscription per
      active project (Story 001), torn down on project switch (respect the
      existing `switchSeq` race guard in `main.ts`). Incoming `file_change`
      events update badges and refresh affected tree nodes — including events
      from jobs this tab did not launch (verify: reload mid-job; badges appear
      when the job's writes land).
- [ ] Opening a file marks it seen (`POST …/files/seen`, debounced) and clears
      its badge. Renames carry state per Story 002.
- [ ] The Files toggle button (`index.html:30`) shows an unseen-count pill;
      count updates live and zeroes as files are viewed.
- [ ] A refresh button in the files header re-fetches the tree; the tree shows
      a loading state during fetch and a retryable error state on failure
      (today: nothing during fetch, `files.ts:163-172`).
- [ ] `mtime` surfaced per file (tooltip or muted inline text).
- [ ] Origin tint uses recorded `agent_slug` when present; the extension-based
      guess (`files.ts:496-501`) remains only as fallback for legacy files.
- [ ] The job-scoped SSE `file_change` handling (`chat.ts:212-220`,
      `main.ts:115-129`) is reconciled with the feed so events aren't
      double-applied.
- [ ] `webapp` token-free check scripts still pass; extend `files-check` (or
      add one) to cover hydrate → live-event → mark-seen.

## Notes

- Files: `webapp/src/files.ts`, `api.ts` (feed client + new endpoints),
  `main.ts` (subscription lifecycle), `chat.ts` (dedupe), `index.html`,
  `style.css` (count pill).
- Keep the feed subscription resilient: auto-reconnect with backoff on drop
  (mirrors the story-028 reconnect-on-reload pattern).
- The `ingesting`/`done` badge states stay dormant until Epic 006's ingestion
  pipeline emits them — do not remove them.
