# Story 001: Project event feed

**Status:** done
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Outcome

All acceptance criteria met (2026-07-12). New in-process hub
`src/project-events.js` (`subscribeProjectEvents`/`publishProjectEvent`, cap
via `config.projectEvents.maxSubscribers`, default 20) and a membership-
guarded `GET /api/projects/:id/events` SSE endpoint with `: connected` +
25 s heartbeat comment frames and unsubscribe-on-close.

Publish sites (documented in the module header):
- **Channel tee**: `EventChannel` gained an optional `onEvent` callback fired
  on every accepted `push` — including while no consumer is attached, which
  is what makes detached/background runs visible. `runAgentTask` passes the
  tee for **top-level runs only** (depth 0); `dispatch_agent` children reach
  the hub through the parent's forwarding, and a WeakSet in the hub makes
  publishing idempotent per event object so overlapping paths can't double-
  publish.
- **Job-start marker** (`{ type: 'job', status: 'started', jobId, agent }`)
  published after `createJob` for top-level runs.
- **Seed route** wraps `runSeedPipeline` in `teeProjectEvents` for the
  pipeline's own stage markers / status-file event.

One deviation from the AC text: the endpoint uses a dedicated handler rather
than `routes/sse.js` `streamEvents` (the feed is endless and needs heartbeat
frames), but emits the identical `data: {json}\n\n` framing, so the webapp's
`readEventStream` parser consumes it unchanged.

Verified: 12 new vitest cases (fan-out to two subscribers + envelope, scoping,
object-level dedupe, throwing-subscriber isolation, cap + cleanup, tee
pass-through, detached-channel tee, throwing-tee isolation, non-member 404,
two live feeds both receiving, disconnect cleanup, 503 over cap) — 157/157
backend tests pass — plus a live curl smoke (SSE headers, `: connected`,
stream stays open, 404 on unknown project).

## Goal

An always-on, project-scoped SSE endpoint that streams `file_change`, job
lifecycle, and agent-activity events to any number of subscribers, regardless
of which job (or whose request) produced them. This is the transport layer
that stories 002/003 and Epic 006's ingestion-status badges build on. Today
these events exist but die inside the single-consumer, job-scoped
`EventChannel` (`agent-backend/src/events.js`) attached to the launching HTTP
response.

## Acceptance Criteria

- [x] An in-process broadcast hub keyed by project id: `subscribe(projectId)`
      returns an iterator/callback registration; `publish(projectId, event)`
      fans out to all current subscribers. Subscriber disconnect (SSE socket
      close) removes the registration; no leak on abrupt client death.
- [x] The agent runtime's channel emissions are teed into the hub at the
      channel/emit chokepoint — **one** wrapping point, not per-tool-call-site
      edits — so every existing and future `file_change`, `notice`, `done`,
      `error`, and seeding `stage` event reaches the hub. Job start is also
      published (job id, agent slug).
- [x] `GET /api/projects/:id/events` streams hub events as SSE using the
      existing `routes/sse.js` framing, so the webapp's `readEventStream`
      parser (`webapp/src/api.ts:438`) consumes it unchanged. Events carry
      enough envelope to attribute them: `{ jobId, agent, ts }` alongside the
      existing payload. *(Same framing via a dedicated handler — see Outcome.)*
- [x] The endpoint is membership-guarded like `routes/projects.js`
      `authorizeProject` (404 on non-member, not 403).
- [x] The existing job-scoped SSE responses (`/api/agent/task`, `/seed`,
      `/reconnect`) are unchanged — the hub is additive.
- [x] Heartbeat/keep-alive comments on the SSE stream so idle connections
      survive proxies; a per-project subscriber cap (config, default ~20).
- [x] Vitest coverage: two subscribers both receive a published event; a
      disconnected subscriber is cleaned up; non-member gets 404.

## Notes

- Files: new `agent-backend/src/project-events.js` (hub), `routes/projects.js`
  or a new `routes/events.js` (endpoint), a small tee in
  `agents/runtime.js`/`events.js` where the channel emits.
- In-process only is fine — the backend is a single process (SQLite,
  in-memory Yjs); no Redis/pub-sub infra.
- The `ws` server (`index.js:35-49`) stays Yjs-only; revisit transport only if
  SSE connection limits become real.
- Webapp consumption is Story 003; this story is verifiable with `curl -N`.
