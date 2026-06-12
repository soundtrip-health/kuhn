# Story 020: Chat Conversation Restore & Interview Polish

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

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
  before the Advisor did any work. Raise the default and/or budget the seeding
  flow explicitly (coordinate with story 015). Reload-resume mid-interview
  remains unverified.

## Acceptance Criteria

- [ ] Backend endpoint to read conversation history for a project (e.g.
      `GET /api/projects/:id/conversations?limit=` returning recent
      conversations with their user/assistant messages)
- [ ] On load, the chat panel renders the recent transcript (at minimum the
      most recent conversation per role, rendered with the same markdown
      pipeline as live messages) before new input is sent
- [ ] When an ask_user question times out or its task ends unanswered, the
      webapp gets a signal (event or terminal state) and exits answer mode with
      a visible notice, instead of silently swallowing the stale reply box
- [ ] A reply to a no-longer-pending question (409 from the reply route) shows
      a clear message and restores normal input mode
- [ ] One full PM interview exercised end-to-end against the live SDK + DB
      (manual or scripted via `webapp/scripts/`), confirming: question round
      trip, `project.json` + `projects.config` written, RA/Advisor dispatch,
      and reload-resume mid-interview (all but reload-resume confirmed in the
      2026-06-11 live run — see Background)
- [ ] Token budget sized so the PM seeding tree (interview + RA + Advisor)
      completes: raise `AGENT_TOKEN_BUDGET` default and/or per-dispatch
      sub-budgets (see Background finding; coordinate with story 015)
- [ ] Budget accounting weights tokens by approximate model cost (decision
      2026-06-12, after story 021 gave each role its own model): a Haiku RA
      token should not count the same as an Opus PM token against the shared
      tree budget. Weight `budget.used` increments by the running agent's
      model price ratio (approx. Haiku 1×, Sonnet 3×, Opus 5×, normalized to
      the PM's tier — exact weights configurable, rough is fine)

## Out of Scope

- Full seeding pipeline (story 015)
- Multi-user conversation views
