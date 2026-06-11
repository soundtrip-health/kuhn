# Story 011: Agent Runtime on Claude Agent SDK

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L
**Completed:** 2026-06-11

## Goal

Stand up agent execution in the backend using the **Claude Agent SDK** (the headless runtime
behind Claude Code), exposed through a provider-neutral **agent-task boundary**. This replaces
the previously planned custom router, custom tool registry, and provider-agnostic
chat-completion interface (story 008, superseded).

## The Agent-Task Boundary

The only contract the rest of the system sees:

```ts
runAgentTask({
  role:      'pm' | 'writer' | 'analyst' | 'advisor' | 'research' | 'review',
  projectId: string,        // project root the task may touch
  input:     string,        // user message or dispatch instruction
  context?:  {              // optional editor context
    selection?: string,
    cursor?:    { line: number },
    files?:     string[],
  },
  sessionId?: string,       // continue a prior conversation
}): AsyncIterable<AgentEvent>

type AgentEvent =
  | { type: 'text';        content: string }            // streamed prose
  | { type: 'file_change'; path: string; kind: 'create'|'update'|'delete' }
  | { type: 'citation';    key: string; bibtex: string }
  | { type: 'question';    content: string }            // agent needs user input
  | { type: 'done';        usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error';       message: string }
```

Routes, the job model, logging, and both frontends depend only on this interface. The Claude
Agent SDK is an implementation detail behind it. We deliberately do **not** abstract individual
LLM calls.

## Acceptance Criteria

- [x] `runAgentTask` implemented on the Claude Agent SDK; system prompt loaded from the DB
      (seeded prompts from story 010), per-role tool allowlist applied
- [x] Agent file access confined to the project directory (interim: SDK workspace = project dir;
      full enforcement lands with the Storage API, story 018)
- [x] Streaming: events reach the browser as they occur (SSE; per-turn granularity — see notes)
- [x] `POST /api/agent/task` (SSE) wired to `runAgentTask`
- [x] Conversation logging: every task's messages, tool calls, and usage written to the
      existing conversation tables
- [x] **Durable job model:** a `jobs` table (id, project_id, role, status, input, created/updated,
      token usage); long-running tasks survive a backend restart at least as resumable records
      with status `interrupted`; UI can list and re-dispatch
- [x] Per-task token budget: a task exceeding its budget is stopped with a clear error event
- [x] Inter-agent dispatch: an agent can request a sub-task (e.g., writer → research) via a
      `dispatch_agent` tool that internally calls `runAgentTask` and streams child progress
- [x] Smoke test: research agent answers a PubMed-style query end-to-end through the boundary

## Implementation Notes (2026-06-11)

- `@anthropic-ai/claude-agent-sdk@0.3.x`. Key option choices: `settingSources: []` (host
  CLAUDE.md/settings never leak into agent context), `permissionMode: 'bypassPermissions'`
  paired with the `tools` option to **remove** built-ins not granted to the role (the
  allowlist alone does not restrict anything under bypassPermissions).
- Code: `agent-backend/src/agents/runtime.js` (boundary + SDK mapping), `events.js`
  (async channel so dispatch_agent can forward child events mid-stream), `search.js`
  (PubMed eutils + arXiv as in-process SDK MCP tools — no external MCP server or API key),
  `src/db/{jobs,agents}.js`, `src/routes/agent.js`.
- DB slug ↔ built-in tool map: `file_read → Read,Grep`; `file_list → Glob`;
  `file_write → Write,Edit`; `web_search → WebSearch,WebFetch`. Role aliases
  `research → ra`, `review → reviewer`.
- Events are tagged with `agent: <slug>`; child (dispatched) events are forwarded except
  the child `done` — the parent emits the single terminal event. Shared token budget
  spans parent + children; budget is checked after each turn, so a task can overshoot by
  one turn's tokens (accepted for the prototype). Input accounting includes prompt-cache
  read/write tokens.
- Endpoints: `POST /api/agent/task` (SSE stream), `GET /api/agent/jobs`,
  `POST /api/agent/jobs/:id/dispatch` (re-dispatch, resumes recorded SDK session).
  Orphaned `pending`/`running` jobs are marked `interrupted` at startup.
- Smoke test (`npm run smoke`): research agent answered a target-trial-emulation query
  with 3 real PMIDs via the in-process pubmed_search tool; job/session/usage and full
  conversation logged. Works with `ANTHROPIC_API_KEY` or Claude Code login credentials.

## Known Issues

- Text events are per-assistant-turn, not token-level. Deferred to Story 013 (chat UI
  decides if it needs `includePartialMessages`).
- `question` AgentEvents are never emitted — agents cannot pause for user input.
  Deferred to Story 012.
- `citation` AgentEvents are never emitted. Deferred to Story 016.

## Technical Notes

- `@anthropic-ai/claude-agent-sdk` (TypeScript). Verify current package name/API against docs
  at implementation time.
- Map per-role tools: file read/write/list (project-scoped), PubMed/arXiv search (port existing
  MCP usage), web search, `dispatch_agent`. The SDK's MCP support can host the existing PubMed
  MCP server directly.
- Keep `agents/*/AGENTS.md` as the prompt source of truth; DB holds the editable copy.
- Sessions: SDK session persistence keyed by `sessionId`, stored per project.

## Out of Scope

- PM interview logic (story 012)
- Storage API hardening (story 018)
- Frontend chat UI (story 013)
