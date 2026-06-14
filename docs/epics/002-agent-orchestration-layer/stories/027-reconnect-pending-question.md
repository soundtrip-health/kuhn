# Story 027: Reconnect a Pending ask_user Question After Reload

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M
**Completed:** 2026-06-14

## Goal

Make a pending `ask_user` question survive a dropped SSE connection. After
[story 020](020-chat-conversation-restore.md), the chat transcript survives a
reload but a *pending question* does not: the run is bound to the single
long-lived `POST /api/agent/task` stream, so a reload/navigation while the agent
is parked waiting for an answer tears the whole run down. The user comes back to
a transcript with no way to answer, and — because the agent's SDK session is
resumed on the next message with the `[No reply received…]` tool result already
baked in — the PM often re-asks the question as plain text and (wrongly) tells
the user "my question may not be showing up on your end." This story lets the
user reload and reconnect to the still-pending question.

## Background (state after story 020)

- `ask_user` (`agent-backend/src/agents/runtime.js`) pushes a `question` event,
  then blocks on `waitForReply(jobId, …)` (`agents/questions.js`) until
  `POST /api/agent/jobs/:id/reply` delivers an answer or the 15-min timeout
  fires. The reply round-trip itself works (verified live).
- `runAgentTask` runs the SDK loop as a detached `pump` pushing into an
  `EventChannel`; the HTTP handler consumes that channel. On consumer
  disconnect, its `finally` interrupted the SDK and marked the job `cancelled`.
- **Two latent problems made disconnect-while-parked misbehave:**
  1. The teardown `finally` could not run promptly. When parked on a question
     no events arrive, so the consumer is suspended in `channel.next()`; a plain
     `generator.return()` (from the SSE `res` `'close'`) cannot run the `finally`
     until that await settles, so the run actually lingered until the 15-min
     timeout rather than cancelling at disconnect.
  2. There was no way to re-attach a stream to a live run, so even a still-parked
     question was unreachable after reload.

## Acceptance Criteria

- [x] A detachable run (the `POST /api/agent/task` chat path) parked on an
      `ask_user` question is **left alive** on browser disconnect instead of
      interrupted+cancelled; its `EventChannel` keeps buffering
- [x] A non-detachable run (sub-agent dispatch, seeding-pipeline tasks) keeps the
      previous behavior: disconnect interrupts the SDK and marks the job cancelled
- [x] Teardown runs **promptly** at disconnect even while parked — the consume
      loop races an `AbortSignal` (wired to `res` `'close'`) against
      `channel.next()`
- [x] `GET /api/agent/pending?projectId=` lists live, parked, unattached runs
      with their question text (in-memory runtime state; returns nothing after a
      server restart)
- [x] `POST /api/agent/jobs/:id/reconnect` re-attaches an SSE stream to a live
      run: re-emits the pending `question` event, then streams subsequent live
      events; `404` when no live run, `409` when one is already attached
      (the `EventChannel` is single-consumer)
- [x] On load, `chat.ts restore()` reconnects to a pending-question run, which
      re-renders the question card and enters answer mode; answering then lets
      the agent continue
- [x] End-to-end verified against the live SDK: question → disconnect → `pending`
      lists the job → reconnect re-emits it → reply → PM continues; and in the
      real webapp by switching to a project with a parked question and answering
      the reconnected card

## Implementation

- `agents/runs.js` (new): in-memory `Map<jobId, RunHandle>` registry
  (`registerRun`/`getRun`/`unregisterRun`/`listLiveRuns`). Only detachable runs
  register; the single chokepoint for removal is the pump `.finally` plus the
  non-parked teardown branch.
- `agents/questions.js`: `waitForReply(jobId, timeoutMs, { question, agent })`
  stores the question text; `getPendingQuestion(jobId)` exposes it for re-emit.
- `agents/events.js`: `EventChannel.detach()` drops the abandoned waiter left by
  the disconnected consumer so events pushed after the reply are buffered for the
  reconnecting consumer instead of swallowed by a dead waiter.
- `agents/runtime.js`: `task.detachable` flag; run registered after job creation;
  `teardownOrDetach(state)` chooses detach (alive, parked) vs. cancel; the
  consume loop (`consume`/`raceNext`) ends promptly on `task.signal`; `reattach(run, signal)`
  re-emits the question and forwards live events sharing the same teardown.
- `routes/agent.js`: task route sets `detachable: true` + an `AbortController`
  wired to `res` `'close'`; new `GET /api/agent/pending` and
  `POST /api/agent/jobs/:id/reconnect`.
- `webapp/src/api.ts`: `getPendingQuestions()`, `reconnectAgent()`.
- `webapp/src/chat.ts`: `restore()` calls `reconnectPendingQuestion()`, which
  reconnects via a fresh `createEventHandler()` — the existing `question` case
  re-renders the card and enters answer mode.
- Tests: `runs.test.js` (registry), `questions.test.js` (pending-question text),
  `runtime.test.js` (detach-keeps-alive + reconnect-continues; non-detachable
  still cancels; normal finish does not register), `routes/agent.test.js`
  (`pending` scoping, reconnect 404/409/200 with re-emitted question).

## Out of Scope

- **Seeding-pipeline reconnect.** Questions asked inside `runSeedPipeline`
  (`agents/seeding.js`) run two generators deep behind multi-stage pipeline state;
  re-attaching mid-pipeline needs a pipeline-level registry and resumable stage
  state. Those runs are left non-detachable (today's teardown). The `detachable`
  flag is the seam to extend later.
- Multi-tab answering (the second tab gets `409` on reconnect).
- Shortening the 15-min detached-run grace window (a parked run holds an SDK
  query + model context open server-side until answered or timed out).
