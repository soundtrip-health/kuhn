# Story 001: User attribution on content rows

**Status:** done
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** S

## Goal

Record who did what. `conversations`, `jobs`, and `messages` carry no
`user_id` today — memory distillation (Story 004) needs attributable
transcripts, and any future multi-user debugging needs the same. Cheap now,
free to harden later: the stamped id becomes trustworthy the moment Story 002
replaces the dev-stub identity, with no further schema work.

## Acceptance Criteria

- [x] Idempotent schema migration adds nullable `user_id` (FK `users`) to
      `conversations`, `jobs`, and `messages`. Existing rows stay NULL
      (unattributable history is honest history — no fake backfill to the dev
      user). — `schema.sql` covers fresh DBs; `db/init.js` gained a
      `COLUMN_MIGRATIONS` table + `applyColumnMigrations()` (pragma-checked
      `ALTER TABLE`) for existing DBs, verified against a copy of the live
      dev database and by `db/init.test.js`.
- [x] Every creation path stamps the current session user: conversation
      get-or-create, job insert, and `logMessage` for user/assistant/tool
      turns (assistant/tool rows carry the user whose request ran the job).
      Also threaded: `dispatch_agent` sub-jobs inherit the dispatching user;
      the seed pipeline stamps the user who triggered it; job re-dispatch
      stamps the re-dispatcher.
- [x] Uploads and file mutations already covered by Epic 005's
      `file_events.created_by`? **Epic 005 shipped without it** — added
      `file_events.user_id` in this migration; user actions (upload / delete
      / rename) stamp `req.user.id` and agent file events carry the
      requesting user via the project-event tee.
- [x] `GET /api/projects/:id/conversations` (transcript restore) includes the
      attribution so the UI *can* label turns later (no UI change required
      here) — `user_id` on both conversation and message rows; NULL for
      pre-attribution history.
- [x] Vitest coverage: a run under user A stamps A on job + messages; a
      second user's run on the same project/agent stamps B on their rows
      while sharing the conversation (documenting today's shared-stream
      behavior — see Notes). — `runtime.test.js` "user attribution (story
      007-001)" block; user B resumes user A's SDK session and still gets B
      on B's rows.

## Notes

- Files: `db/schema.sql`, `db/conversation.js`, `db/jobs` write sites in
  `agents/runtime.js`/`routes/agent.js`, `session.js` (already resolves the
  user).
- This story deliberately does **not** split conversation streams per user —
  the story-013 known issue ("per-role single SDK session… must be revisited
  with multi-user/auth") stays open, now with the data to observe how often
  collisions actually happen. Forward pointer lives in the epic's Deferred
  list.
