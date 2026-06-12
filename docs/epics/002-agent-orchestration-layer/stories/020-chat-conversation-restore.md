# Story 020: Chat Conversation Restore & Interview Polish

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M
**Completed:** 2026-06-12

## Goal

Finish the conversation-continuity work started in story 012. After 012, a page
reload resumes the *SDK session* (the agent remembers the conversation), but the
chat panel itself comes back empty, and the ask_user question flow has rough
edges. This story makes the chat panel survive a reload and hardens the
question round-trip.

## Background (state after story 012)

- Every turn is already logged to Postgres (`conversations` / `messages` tables,
  story 011) — the data for transcript restore exists; there is just no read API
  or UI for it.
- On load, `webapp/src/chat.ts` seeds its per-role session map from
  `GET /api/agent/jobs?projectId=` (newest job with a `session_id` per role) and
  passes the session id on the next message, so agents continue mid-conversation.
- `ask_user` (agent-backend `src/agents/runtime.js`) blocks until
  `POST /api/agent/jobs/:id/reply` delivers an answer, with a timeout
  (`AGENT_QUESTION_TIMEOUT_MS`, default 15 min) after which the agent is told to
  proceed with defaults. The webapp is not told the question expired; the input
  box stays in answer mode until the task's stream ends.
- **Live run 2026-06-11 (project 2, job 8):** a full PM interview was exercised
  end-to-end via curl against the live SDK. Confirmed working: 3-question
  adaptive interview over the question/reply round trip, `save_project_config`
  (verified in `projects.config` and `project.json`), and RA + Advisor dispatch
  (jobs 9/10, `parent_job_id = 8`). **Finding:** the default per-task token
  budget (`AGENT_TOKEN_BUDGET`, 250k, shared across the dispatch tree and
  counting cache reads) is too small for interview + RA + Advisor — the RA's
  literature search consumed ~150k and the tree died on "Token budget exceeded"
  before the Advisor did any work. Reload-resume mid-interview remained
  unverified.

## Acceptance Criteria

- [x] Backend endpoint to read conversation history for a project
      (`GET /api/projects/:id/conversations?limit=` returning recent top-level
      conversations with their user/assistant messages)
- [x] On load, the chat panel renders the recent transcript (the last 20
      top-level conversations, merged chronologically, rendered with the same
      markdown pipeline as live messages) before new input is sent
- [x] When an ask_user question times out, the backend emits a
      `question_expired` event and the webapp exits answer mode with a visible
      notice; when the task's stream ends with a question still pending, the
      webapp shows "the task ended before you answered"
- [x] A reply to a no-longer-pending question (409 from the reply route) shows
      a clear message and restores normal input mode
- [x] One full PM interview exercised end-to-end against the live SDK + DB —
      question round trip, `project.json` + `projects.config`, RA/Advisor
      dispatch all confirmed in the 2026-06-11 live run; **reload-resume
      mid-interview deferred to [Story 022](022-live-seeding-verification.md)**
      (scripted as `webapp/scripts/reload-resume-check.mjs`; live runs burn
      subscription quota)
- [x] Token budget sized so the PM seeding tree completes:
      `AGENT_TOKEN_BUDGET` default raised 250k → 500k, and story 015's pipeline
      runs each stage as its own top-level task with its own budget
- [x] Budget accounting weights tokens by approximate model cost (decision
      2026-06-12): increments are scaled by the running agent's price weight
      relative to the root agent's tier (Haiku 1×, Sonnet 3×, Opus 5×;
      configurable via `AGENT_MODEL_WEIGHTS`, e.g. `haiku:1,sonnet:3,opus:5`)

## Implementation

- `db/conversation.js#listProjectConversations` + `GET /api/projects/:id/conversations`
  (routes/projects.js). Sub-agent conversations (jobs with a `parent_job_id`) are
  excluded so dispatch instructions don't replay as fake user messages.
- `runtime.js`: `question_expired` event pushed when `waitForReply` times out
  (no-op on task teardown — the channel is already closed); weighted budget via
  `modelCostWeight()` and `budget.baseWeight` pinned by the root task's model.
- `webapp/src/chat.ts`: `restore()` renders the transcript then seeds the session
  map; event handling extracted to `createEventHandler()` (shared with the story
  015 seed stream); answer-mode exits visibly on `question_expired`, stream end,
  and 409 replies.
- Tests: `runtime.test.js` (weighted budget × 3, question_expired via fake
  timers), `conversation.test.js`, `projects.test.js`.

## Known Issues

- Reload-resume mid-interview not yet exercised against the live SDK.
  **Deferred to [Story 022](022-live-seeding-verification.md).**

## Out of Scope

- Full seeding pipeline (story 015)
- Multi-user conversation views
