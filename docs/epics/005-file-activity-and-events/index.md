# Epic 005: File Activity & Project Events

**Status:** done
**Created:** 2026-07-12
**Updated:** 2026-07-12 (004 shipped — epic complete: all four stories done)

## Goal

Make the file manager live and trustworthy. Today the tree only updates when
the webapp itself triggered the change: `file_change` events exist server-side
but are delivered only on the job-scoped SSE stream that launched the task, and
the webapp's new/changed badges live in an in-memory `statusMap` that is wiped
on reload and project switch (`webapp/src/files.ts:45,63`). If a file changes
while the user isn't watching that exact stream — reload mid-job, a
collaborator's agent, a background job — the tree silently goes stale, and
"new" markers never survive a refresh.

This epic adds the two missing layers:

1. **A project-scoped event feed** — an always-on subscription that fans out
   `file_change` and agent-activity events for a project regardless of which
   job (or which user's job) produced them.
2. **Persisted file activity with a per-user "seen" model** — VS Code-style
   semantics: a file is highlighted when it changed since *this user* last
   looked at it, and the badge clears when they open it. Survives reload.

Together these also give collaborators awareness of each other's agent
activity for the first time (today each SSE channel has exactly one consumer).

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Feed transport | **SSE: `GET /api/projects/:id/events`** | Reuses `routes/sse.js` + the client's existing `readEventStream` parser (`webapp/src/api.ts:438`). The `ws` server stays Yjs-only. WebSocket fan-out can come later if SSE connection limits bite. |
| Event source | **Broadcast hub beside `EventChannel`** | The runtime already emits `file_change` at every write site (`agents/runtime.js:487-754`, `seeding.js:76`). Tee those into a per-project in-process hub with N subscribers; don't rework the job-scoped channel contract. |
| Activity persistence | **`file_events` table** (append-only) | Written at the same emit sites; gives reload-safe badges, an audit trail of who/what touched each file, and the data a future activity panel needs. |
| Seen model | **Per-user `file_seen(user_id, project_id, path, seen_at)`** | Badge = latest `file_events.created_at` > `seen_at` (or no seen row). Per-user, not per-project-global, so collaborators' badges are independent. |
| Tree metadata | **Add `mtime` (and render `size`) to the tree API** | `TreeNode` has no timestamps at all (`webapp/src/api.ts:26-32`); mtime is needed for tooltips and as a fallback ordering signal. |

## Scope

### Must Have

- [ ] Project-scoped SSE event feed carrying `file_change`, job start/done, and
      agent-activity events, independent of the originating request
- [ ] `file_events` persisted at every backend emit site; per-user seen state
- [ ] File manager hydrates badge state from the server on load, subscribes to
      the feed, and clears a file's badge when the user opens it
- [ ] Unseen-count badge on the Files toggle button
- [ ] Manual refresh affordance + loading state on the tree
- [ ] `mtime` in the tree API, surfaced in the UI (tooltip or detail row)

### Deferred

- Toast notifications for background agent writes (feed makes them possible)
- Presence/awareness UI beyond file badges (who's online, who's running what)
- File version history / git integration (Epic 002 deferred list still owns it)
- WebSocket transport for the feed (only if SSE proves limiting)

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Project event feed](stories/001-project-event-feed.md) — broadcast hub + `GET /api/projects/:id/events` SSE endpoint, membership-guarded | done | M |
| 002 | [Persisted file activity & seen model](stories/002-file-activity-seen-model.md) — `file_events` + `file_seen` tables, activity/seen endpoints, `mtime` in tree API | done | M |
| 003 | [Live file manager UX](stories/003-live-file-manager-ux.md) — server-hydrated badges, feed subscription, clear-on-open, unseen count, refresh + loading state | done | L |
| 004 | [File-tree a11y & UI debt sweep](stories/004-file-tree-a11y-debt-sweep.md) — tree roles/keyboard nav, focus management, loading/error states, small webapp debt items | done | M |

## Sequencing

001 → 002 → 003 sequential (003 consumes both). 004 is independent and can run
any time; doing it alongside 003 avoids touching `files.ts` twice.

## Risks

- **Emit-site drift** — `file_change` is emitted from ~6 call sites in
  `runtime.js`/`seeding.js`; persisting and broadcasting must wrap the same
  chokepoint (the channel emit), not be hand-added per site, or new tools will
  silently skip the feed.
- **Seen-state write volume** — mark-seen fires on every file open; keep it a
  single upsert and debounce client-side.
- **Multi-tab/user fan-out** — the hub must handle subscriber disconnects
  cleanly (SSE clients vanish without notice); cap subscribers per project.
