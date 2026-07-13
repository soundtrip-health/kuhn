# Story 001: Project event feed

**Status:** ready
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Goal

An always-on, project-scoped SSE endpoint that streams `file_change`, job
lifecycle, and agent-activity events to any number of subscribers, regardless
of which job (or whose request) produced them. This is the transport layer
that stories 002/003 and Epic 006's ingestion-status badges build on. Today
these events exist but die inside the single-consumer, job-scoped
`EventChannel` (`agent-backend/src/events.js`) attached to the launching HTTP
response.

## Acceptance Criteria

- [ ] An in-process broadcast hub keyed by project id: `subscribe(projectId)`
      returns an iterator/callback registration; `publish(projectId, event)`
      fans out to all current subscribers. Subscriber disconnect (SSE socket
      close) removes the registration; no leak on abrupt client death.
- [ ] The agent runtime's channel emissions are teed into the hub at the
      channel/emit chokepoint — **one** wrapping point, not per-tool-call-site
      edits — so every existing and future `file_change`, `notice`, `done`,
      `error`, and seeding `stage` event reaches the hub. Job start is also
      published (job id, agent slug).
- [ ] `GET /api/projects/:id/events` streams hub events as SSE using the
      existing `routes/sse.js` framing, so the webapp's `readEventStream`
      parser (`webapp/src/api.ts:438`) consumes it unchanged. Events carry
      enough envelope to attribute them: `{ jobId, agent, ts }` alongside the
      existing payload.
- [ ] The endpoint is membership-guarded like `routes/projects.js`
      `authorizeProject` (404 on non-member, not 403).
- [ ] The existing job-scoped SSE responses (`/api/agent/task`, `/seed`,
      `/reconnect`) are unchanged — the hub is additive.
- [ ] Heartbeat/keep-alive comments on the SSE stream so idle connections
      survive proxies; a per-project subscriber cap (config, default ~20).
- [ ] Vitest coverage: two subscribers both receive a published event; a
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
