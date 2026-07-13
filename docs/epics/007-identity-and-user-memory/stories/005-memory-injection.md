# Story 005: Memory injection at run time

**Status:** ready
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** M

## Goal

The read path: agents see what Kuhn knows about the current user. A bounded,
relevance-ranked "About the user you are working with" footer composed into
the system prompt at task launch. `buildSystemPrompt`
(`agents/runtime.js:466-476`) injects nothing user-specific today — this is
the seam.

## Acceptance Criteria

- [ ] `buildSystemPrompt` gains a memory footer for the requesting user:
      top-N active memories (config, e.g. 10), org-scoped facts only when the
      task's project belongs to that org, ranked by kind relevance to the
      agent role (writer/reviewer weight `style`; advisor weights
      `workflow`/`domain`) then recency of reinforcement. Hard token budget
      (~400 tokens); truncate by rank, never mid-fact.
- [ ] Framing in the footer makes memories **advisory context, not
      instructions**: user preferences inform tone/format choices but never
      override the task, safety behavior, or explicit in-conversation
      requests (the current request always wins over a stored preference).
- [ ] Zero-memory and memory-paused users get byte-identical prompts to
      today's (no empty header injected).
- [ ] The footer is included in the persisted job record or derivable from it
      (which memory ids were injected) — needed for the panel's "used in
      recent sessions" display (006) and for debugging bad behavior back to a
      bad memory.
- [ ] Seeding pipeline (`/seed`) and `dispatch_agent` sub-tasks inherit the
      originating user's memories consistently (one user context per
      pipeline, from the requesting session).
- [ ] Behavioral spot-check: a scripted live check (quota-spending, like
      `npm run smoke`) demonstrating a planted style preference measurably
      alters writer output; documented, run manually, not in CI.
- [ ] Vitest coverage: ranking/budget/truncation logic; org-scope filtering;
      paused → excluded; injected-ids recorded.

## Notes

- Files: `agents/runtime.js` (`buildSystemPrompt`, task launch),
  `db/user-memories.js` (ranked query), `config.js` (N, token budget).
- Keep selection deterministic (rank function, no model call) — injection
  must add zero latency and zero token spend beyond the footer itself.
- If injected memories ever conflict, prefer the more recently reinforced and
  archive-flag the loser for the distiller to reconcile (log, don't crash).
