# Story 002: Persisted file activity & seen model

**Status:** done
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Outcome

All acceptance criteria met (2026-07-12). `file_events` + `file_seen` tables
(idempotent migration verified against a pre-story DB), new
`db/file-activity.js` (record + prune to `FILE_ACTIVITY_MAX_EVENTS`, default
1000; `unseenPaths`; `markSeen` upsert; `migrateSeenPaths` incl. directory
subtrees), and guarded `POST /api/projects/:id/files/seen` +
`GET /api/projects/:id/files/activity` endpoints. The tree API now carries
`mtime` per file and per-node `unseen` flags for the session user.

**Persistence chokepoint:** `publishProjectEvent` (the story-001 hub) writes
`file_events` for every `file_change` it accepts — with or without live
subscribers, and behind the same WeakSet dedupe — so agent writes, seeding,
and the new user-action publishes (upload/delete/move in `routes/files.js`)
all persist through one point.

Decisions recorded:
- **Editor autosave (`PUT /file`) is deliberately not published/persisted** —
  it would flood the log and keep the open document perpetually unseen; live
  doc sync is Yjs's job (documented on the route). Follow-up consideration
  belongs to story 003 if collaborator-edit badges are wanted.
- **Moves surface as the delete+create pair** the agent `move_file` tool
  already emits (the `rename` kind stays reserved in the schema CHECK). Seen
  rows are re-keyed so state follows the file, and the create event still
  flags the moved file unseen — "renamed = changed", VS Code-style. Both the
  UI move route and the agent tool migrate seen paths.
- The tree route itself remains membership-unguarded like the rest of
  `routes/files.js` (the known Epic 004 story-005 deferral, owned by the
  Epic 007 Deferred list); the new seen/activity routes live in
  `routes/projects.js` behind `authorizeProject`.

Verified: 11 new vitest cases (168/168 pass) — activity round-trip, prune
cap, unseen flip across seen-upsert and back, per-user isolation +
delete-suppression, directory-subtree seen migration, hub-persistence
exactly-once + failure isolation, route publishes on upload/delete/move,
tree mtime/unseen annotation, endpoint guards — plus a live probe against a
running backend (upload → unseen:true + mtime → activity row → seen clears →
move re-flags at the new path → feed carried all three events).

## Goal

Persist file activity server-side and record what each user has seen, so
new/changed markers survive reload and are per-user (VS Code semantics: a file
is "new" if it changed since *you* last opened it). Today badge state is a
client-side `Map` wiped on reload/project switch (`webapp/src/files.ts:45,63`)
and the tree API carries no timestamps at all (`webapp/src/api.ts:26-32`).

## Acceptance Criteria

- [x] Idempotent schema additions in `agent-backend/src/db/schema.sql`:
      - `file_events` (id, project_id FK cascade, path, kind
        create|update|delete|rename, agent_slug nullable — null = user action,
        job_id nullable, created_at). Indexed on (project_id, path, created_at).
      - `file_seen` (user_id, project_id, path, seen_at; PK on the triple).
- [x] `file_events` rows are written at the same chokepoint that publishes to
      the Story 001 hub (agent writes, uploads, deletes, renames — uploads via
      `routes/files.js` count too, with `agent_slug` null). Renames migrate or
      re-key the path consistently with `storage.js` semantics.
- [x] `GET /api/projects/:id/files` (tree) gains `mtime` per file node and a
      per-node `unseen` flag computed for the current session user (latest
      event > `seen_at`, or an event exists with no seen row). `size` is
      already in the payload — keep it.
- [x] `POST /api/projects/:id/files/seen` upserts `file_seen` for the current
      user (body: `{ path }`; idempotent).
- [x] `GET /api/projects/:id/files/activity?since=<ts>` returns recent
      `file_events` (bounded, newest first) for hydration/audit.
- [x] All new routes membership-guarded; `file_events` prunes or caps per
      project (config, e.g. keep last 1000) so the table can't grow unbounded.
- [x] Vitest coverage: event written on agent write and on upload; unseen flag
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
