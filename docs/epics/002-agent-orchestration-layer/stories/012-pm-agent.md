# Story 012: PM Agent — Interview Flow & Project Configuration

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** XL
**Completed:** 2026-06-11

## Goal

The PM agent conducts the intake interview with a new user, configures the project
(type, scope, deliverables), creates the project record, and dispatches the RA and
Advisor agents to begin background work during seeding (see story 015 for the full
seeding flow; this story owns the PM agent's interview behavior and dispatch logic).

## Acceptance Criteria

- [x] PM agent runs through `runAgentTask` (story 011 boundary) with role `pm`
- [x] Interactive interview: the PM can ask the user a question mid-task and block until
      the answer arrives — implemented as an in-process `ask_user` MCP tool whose result
      is supplied by the chat UI (see Implementation below)
- [x] Interview output: structured project config (type, title, research question,
      deliverables, timeline) written to `projects.config` and the project workspace
      (`project.json`), via a dedicated `save_project_config` tool
- [x] PM dispatches RA and Advisor sub-tasks via `dispatch_agent` with self-contained
      instructions (dispatch mechanics from story 011; PM prompt updated to require
      self-contained task descriptions)
- [x] Conversation resumable across page reloads via the recorded SDK session id
      (webapp seeds its per-role session map from `GET /api/agent/jobs` on load)

## Implementation

### ask_user round trip (the story 011 deferral)

- `agent-backend/src/agents/questions.js` — pending-question registry keyed by job id:
  `waitForReply(jobId, timeoutMs)` / `deliverReply(jobId, reply)` / `cancelQuestion(jobId)`.
- `ask_user` MCP tool (runtime.js, `ask_user` tool slug, PM-only): pushes
  `{ type: 'question', agent, jobId, content }` onto the task's event channel, then
  blocks in the registry. On timeout (`AGENT_QUESTION_TIMEOUT_MS`, default 15 min) or
  task teardown the tool returns a "proceed with defaults" nudge instead of hanging.
- `POST /api/agent/jobs/:id/reply` (routes/agent.js) delivers the user's answer into
  the running job; events keep flowing on the job's original SSE stream. 409 when no
  question is pending.
- Teardown: when the SSE consumer disconnects, `runAgentTask` cancels the job's pending
  question before interrupting the SDK, so the tool handler never leaks.
- Webapp (`chat.ts`): a `question` event renders an accented question bubble and switches
  the input box into answer mode; the next submit POSTs to the reply route instead of
  starting a new task.

### Project configuration

- `save_project_config` MCP tool (`project_config` tool slug, PM-only): validates
  title / project_type (enum) / research_question / deliverables / timeline /
  source_materials, updates `projects.name`, `projects.project_type`, and merges into
  `projects.config` (`db/projects.js#updateProjectConfig`), writes `project.json` to the
  workspace root through the storage service, and emits a `file_change` event.

### Prompt & seeding

- `agents/pm/AGENTS.md`: new "Running Inside the Kuhn Webapp" section instructing the PM
  to interview one question at a time via `ask_user`, call `save_project_config` once
  before dispatching, and dispatch RA + Advisor with self-contained instructions.
- `db/seed.js`: `ask_user` and `project_config` tool definitions, both assigned to `pm`.

### Tests

- `agents/questions.test.js` — registry semantics (deliver, timeout, cancel, supersede)
- `agents/runtime.test.js` — PM tool exposure; full ask_user round trip through the
  event stream (question event → deliverReply → reply text reaches the agent); pending
  question cancelled on consumer disconnect; save_project_config DB + file writes and
  error mapping
- `routes/agent.test.js` — reply route (400 / 409 / delivery)

## Known Issues

- Chat transcript is not re-rendered after a reload (only SDK-session continuity);
  question-timeout has no UI signal; live end-to-end interview run still to be
  exercised. **Deferred to [Story 020](020-chat-conversation-restore.md).**

## Out of Scope

- Skeleton document generation and full seeding pipeline (story 015)
- Webapp chat UI itself (story 013)
