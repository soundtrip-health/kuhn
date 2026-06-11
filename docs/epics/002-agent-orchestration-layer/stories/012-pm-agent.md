# Story 012: PM Agent — Interview Flow & Project Configuration

**Status:** draft
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** XL

## Goal

The PM agent conducts the intake interview with a new user, configures the project
(type, scope, deliverables), creates the project record, and dispatches the RA and
Advisor agents to begin background work during seeding (see story 015 for the full
seeding flow; this story owns the PM agent's interview behavior and dispatch logic).

## Acceptance Criteria

- [ ] PM agent runs through `runAgentTask` (story 011 boundary) with role `pm`
- [ ] Interactive interview: the PM can ask the user a question mid-task and block until
      the answer arrives — requires the runtime to emit `question` AgentEvents and accept
      a reply into the running session (deferred from story 011, which never emits
      `question`; likely via the SDK `canUseTool`/permission callback or a dedicated
      `ask_user` in-process tool whose result is supplied by the chat UI)
- [ ] Interview output: structured project config (type, title, research question,
      deliverables, timeline) written to `projects.config` and the project workspace
- [ ] PM dispatches RA and Advisor sub-tasks via `dispatch_agent` with self-contained
      instructions
- [ ] Conversation resumable across page reloads via the recorded SDK session id

## Inherited from Story 011

- `question` event type exists in the AgentEvent union but is never emitted; no mechanism
  yet for user replies to reach a running task. This story must design and implement that
  round-trip (runtime + route + chat UI hook).

## Out of Scope

- Skeleton document generation and full seeding pipeline (story 015)
- Webapp chat UI itself (story 013)
