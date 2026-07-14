# Story 036: Let the user stop or redirect agent work

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

There is **no way for a user to stop a running agent**. Once a chat task or a
seeding pipeline starts, it runs to completion — through a rabbit hole, through
a misunderstood instruction, through a change of mind — and the PI can only
watch. The one available interrupt is *closing the browser tab*, which is both
undiscoverable and destructive: it tears down your view of the run as the price
of stopping it.

This is a bad shape for a tool that spends real money and real time on every
turn. A single Advisor run during seeding was observed consuming **678k input
tokens** (job 38, 2026-07-14); a user who realizes in the first ten seconds that
the agent misunderstood them currently has no way to say so.

The PI must be able to say **stop** — and, more usefully, **"no, do this
instead."**

## The mechanism already exists

This is a plumbing and UI story, not a runtime story. Everything needed to
interrupt a run is already built and exercised:

- `sdkQuery.interrupt()` cancels the SDK loop (`agents/runtime.js:180`).
- `cancelQuestion(jobId)` unblocks a run parked inside `ask_user`
  (`agents/questions.js:61`).
- `'cancelled'` is already a legal `jobs.status` value (`db/schema.sql:156`).
- `teardownOrDetach()` (`runtime.js:164`) already composes all three correctly.
- Seeding already stops its in-flight tasks when its consumer goes away
  (`agents/seeding.js:122`).

What's missing is a **trigger the user can reach**: today `teardownOrDetach`
fires only as a side effect of the SSE consumer dropping.

**The one real gap:** only `detachable` runs are entered in the run registry
(`runtime.js:242-244`), so a cancel endpoint would have no handle by which to
find a *seeding* run. Registering every run — not just detachable ones — is the
enabling change.

## Acceptance Criteria

- [ ] **Every run is registered** in the run registry, not just `detachable`
      ones, so any in-flight job can be found by id and interrupted.
- [ ] **`POST /api/agent/jobs/:id/cancel`** — interrupts the SDK loop, unblocks
      any pending question, marks the job `cancelled`, and emits a terminal
      event to the SSE stream so an attached UI settles cleanly. Idempotent;
      a cancel on an already-finished job is a no-op, not an error.
      Membership-checked like the other project routes.
- [ ] Cancelling a **seeding pipeline** stops the whole pipeline (including
      in-flight sub-tasks — RA/Advisor/writer), not just the stage in front.
      Sub-jobs are marked `cancelled` too; no orphan is left `running`.
- [ ] **A stop control in the chat UI**, visible whenever a run is streaming.
      One click, no confirmation dialog — the whole point is that it's faster
      than the agent.
- [ ] **A stop control in the seeding panel**, same semantics.
- [ ] **Redirect, not just abort**: typing a new message while a run is in
      flight offers "stop and send" — the common case is not "stop", it's
      "stop, you misunderstood, do this instead." Getting this right is most of
      the value of the story.
- [ ] **Partial work is preserved and legible.** Files the agent already wrote
      stay written; the chat transcript shows the turn ended because *you*
      stopped it (not as an error, and not silently). A cancelled run must be
      visually distinguishable from a crashed one.
- [ ] Token usage accrued before the stop is still recorded on the job — a
      stopped run must not silently lose its cost accounting.
- [ ] Vitest coverage: cancel mid-run; cancel while parked on `ask_user`;
      cancel a seeding pipeline with live sub-tasks; cancel an already-finished
      job (no-op); cancel a job you aren't a member of (refused).

## Notes

- Raised 2026-07-13 by the PI, watching a seeding pipeline he had no way to
  stop.
- Interaction with **story 027** (detachable runs / reconnect): a run parked on
  a question is deliberately kept alive across a disconnect so it can be
  resumed. An *explicit* cancel must override that — the user asking to stop is
  not the same event as a browser dropping its connection, and the two must not
  be conflated in `teardownOrDetach`.
- Think about the **escalation ladder** while designing: stop this turn / stop
  the whole pipeline / pause. Only the first two are in scope here; note where
  pause would land if it's cheap to leave room for it.
- Worth considering as a follow-up: a **spend ceiling** per run with a prompt to
  continue. Story 029 already interrupts on a token budget
  (`config.js:57`, `runtime.js:373-388`) — but the ceiling is invisible to the
  user and not adjustable in the moment. The 678k-token Advisor run suggests the
  budget is not doing the job a user would want it to do. File separately if it
  grows past a paragraph.
