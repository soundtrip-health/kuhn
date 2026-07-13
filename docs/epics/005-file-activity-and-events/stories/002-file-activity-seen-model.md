# Story 002: Persisted file activity & seen model

**Status:** ready
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Goal

Persist file activity server-side and record what each user has seen, so
new/changed markers survive reload and are per-user (VS Code semantics: a file
is "new" if it changed since *you* last opened it). Today badge state is a
client-side `Map` wiped on reload/project switch (`webapp/src/files.ts:45,63`)
and the tree API carries no timestamps at all (`webapp/src/api.ts:26-32`).

## Acceptance Criteria

- [ ] Idempotent schema additions in `agent-backend/src/db/schema.sql`:
      - `file_events` (id, project_id FK cascade, path, kind
        create|update|delete|rename, agent_slug nullable — null = user action,
        job_id nullable, created_at). Indexed on (project_id, path, created_at).
      - `file_seen` (user_id, project_id, path, seen_at; PK on the triple).
- [ ] `file_events` rows are written at the same chokepoint that publishes to
      the Story 001 hub (agent writes, uploads, deletes, renames — uploads via
      `routes/files.js` count too, with `agent_slug` null). Renames migrate or
      re-key the path consistently with `storage.js` semantics.
- [ ] `GET /api/projects/:id/files` (tree) gains `mtime` per file node and a
      per-node `unseen` flag computed for the current session user (latest
      event > `seen_at`, or an event exists with no seen row). `size` is
      already in the payload — keep it.
- [ ] `POST /api/projects/:id/files/seen` upserts `file_seen` for the current
      user (body: `{ path }`; idempotent).
- [ ] `GET /api/projects/:id/files/activity?since=<ts>` returns recent
      `file_events` (bounded, newest first) for hydration/audit.
- [ ] All new routes membership-guarded; `file_events` prunes or caps per
      project (config, e.g. keep last 1000) so the table can't grow unbounded.
- [ ] Vitest coverage: event written on agent write and on upload; unseen flag
      flips correctly across seen-upsert; prune respects the cap.

## Notes

- Files: `db/schema.sql`, new `db/file-activity.js`, `routes/files.js`,
  the Story 001 chokepoint, `storage.js` (mtime in tree walk).
- `user_id` here uses the existing session identity (`session.js`). That
  identity is a dev stub until Epic 007 — acceptable: seen-state is
  low-stakes and the schema is already per-user, so it hardens for free when
  real auth lands.
- Origin attribution (`agent_slug`) lets Story 003 drop the file-extension
  guessing in `files.ts:496-501` for files with recorded history.
