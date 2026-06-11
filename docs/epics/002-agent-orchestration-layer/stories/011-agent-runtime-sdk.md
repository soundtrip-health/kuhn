# Story 011: Agent Runtime on Claude Agent SDK

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

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

- [ ] `runAgentTask` implemented on the Claude Agent SDK; system prompt loaded from the DB
      (seeded prompts from story 010), per-role tool allowlist applied
- [ ] Agent file access confined to the project directory (interim: SDK workspace = project dir;
      full enforcement lands with the Storage API, story 018)
- [ ] Streaming: events reach the browser over WebSocket as they occur
- [ ] `POST /api/agent/task` (HTTP + WS upgrade or SSE) wired to `runAgentTask`
- [ ] Conversation logging: every task's messages, tool calls, and usage written to the
      existing conversation tables
- [ ] **Durable job model:** a `jobs` table (id, project_id, role, status, input, created/updated,
      token usage); long-running tasks survive a backend restart at least as resumable records
      with status `interrupted`; UI can list and re-dispatch
- [ ] Per-task token budget: a task exceeding its budget is stopped with a clear error event
- [ ] Inter-agent dispatch: an agent can request a sub-task (e.g., writer → research) via a
      `dispatch_agent` tool that internally calls `runAgentTask` and streams child progress
- [ ] Smoke test: research agent answers a PubMed-style query end-to-end through the boundary

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
