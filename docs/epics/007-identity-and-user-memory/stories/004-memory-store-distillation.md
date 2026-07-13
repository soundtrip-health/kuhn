# Story 004: User memory store & distillation

**Status:** ready
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** L

## Goal

The memory system's write path: a `user_memories` store of small durable
facts, populated by a cheap post-job distillation pass over the already-
persisted transcript. No agent turns are spent on bookkeeping; the
interactive path stays exactly as fast as today.

## Acceptance Criteria

- [ ] Idempotent schema: `user_memories` (id, user_id FK CASCADE, org_id
      nullable FK — null = user-global, kind
      `preference|style|domain|workflow`, content ≤ ~280 chars, source_job_id
      nullable, confidence, status `active|paused|archived`, created_at,
      updated_at, last_reinforced_at). Indexed on (user_id, status).
- [ ] Post-job distillation: after a job completes (hook at the same
      completion point that finalizes the `jobs` row), an async pass sends
      the job's message transcript to **Haiku** with a distillation prompt
      that extracts only *durable, cross-session* facts — explicit user
      preferences ("always include effect sizes with CIs"), style corrections
      the user made, stable domain context — and explicitly rejects
      task-specific trivia. Output is structured (JSON list of
      {kind, content, confidence}).
- [ ] Distillation is fail-soft and non-blocking: model errors are logged and
      dropped (reuse the story-029 transient-error handling); the job result
      is never affected. Skipped entirely for jobs with no user turns (e.g.
      pipeline-internal dispatches).
- [ ] Dedup/reinforce: a new fact semantically matching an existing one
      (start simple: normalized-text similarity) updates
      `last_reinforced_at`/confidence instead of inserting. Contradictions
      (user says the opposite later) archive the old fact.
- [ ] Caps and decay: max active memories per user (config, e.g. 50); at cap,
      lowest-confidence/oldest-reinforced archived first. Facts never
      reinforced within N months decay to archived.
- [ ] Tenancy: memories are keyed to user (and optionally org) — never
      project — and no query path can return another user's memories.
      Scoping tests mandatory.
- [ ] Distillation-quality eval: a fixture set of ~5 synthetic transcripts
      (preference stated, correction made, pure task noise) with expected
      extract/reject outcomes, runnable as a cheap scripted check; results
      recorded in this story on completion.
- [ ] Vitest coverage: schema round-trip, dedup/reinforce, contradiction
      archival, cap eviction, cross-user isolation.

## Notes

- Files: `db/schema.sql`, new `db/user-memories.js`, new
  `agent-backend/src/agents/distill.js`, hook in `agents/runtime.js` job
  completion, `config.js` (model id, caps), distillation prompt as
  `db/prompts/` sibling or inline constant (it's runtime infrastructure, not
  a seeded agent — keep it out of the `agents` table).
- Depends on Story 001 (`messages.user_id`) to attribute transcripts.
- Works fine on dev-stub identity; becomes per-real-person when 002 lands.
- The distillation prompt is the quality lever — expect iteration; the eval
  fixture is what makes that iteration safe.
- An explicit "remember this" user command and org-level house-style memory
  are deferred (epic Deferred list).
