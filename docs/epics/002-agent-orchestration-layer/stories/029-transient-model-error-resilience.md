# Story 029: Transient Model-Provider Error Resilience (backoff + visible retry)

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S–M

## Implementation (2026-06-21)

- **Backend** (`agent-backend/src/agents/runtime.js`, `config.js`): `runTask`
  wraps the SDK query in `runSdkAttempt()` and retries transient failures with
  exponential backoff + full jitter (`config.agent.retry`, env-overridable;
  default 5 attempts, 1.5s base, 30s cap). Resume the live session on retry so
  completed turns aren't re-run. Each backoff emits a `notice` event
  (`reason: 'provider_overloaded'`, `attempt`, `maxAttempts`, `nextRetryMs`).
  `isTransientApiError()` classifies by HTTP status (408/409/425/429/5xx/529) or
  error text (overloaded / rate-limit / network). A terminal transient failure
  is tagged `reason: 'provider_overloaded'` and carries `state.sdkSessionId`.
- **Frontend** (`webapp/src/chat.ts`, `status.ts`, `api.ts`, `style.css`): the
  `notice` event drives a visible "retrying…" status; the tagged terminal error
  renders a `.chat-notice-overload` card with a one-click **Try again** that
  re-runs the stored `retryAction` — the chat turn (resuming the session) or the
  seeding pipeline, whichever failed.
- **Tests**: `runtime.test.js` covers transient-then-success (one notice → done),
  exhausted retries (notices → tagged terminal error), non-transient pass-through,
  session-id handoff, and `isTransientApiError` classification. Full backend
  suite (142) + webapp `tsc` build green.

**Not exercised against a real 529** — the retry/notice/card logic is unit-tested
with a mocked SDK; live behavior against an actual provider overload wasn't
reproduced on demand. The doubled-turn cosmetic note (a turn that half-streams
before failing re-streams on resume) is documented in the runtime comment.

## Goal

When the Anthropic API returns a transient error (`529 Overloaded`, `429`
rate-limit, `5xx`), the agent runtime should retry with exponential backoff and
the chat UI should show an actionable, self-explanatory notice — instead of a
long silent hang that finally surfaces a raw `API Error: 529 Overloaded`.

## Background — the gap

Surfaced 2026-06-21: a new doc request returned no response from any agent for a
long time, then eventually surfaced `API Error: 529 Overloaded`. The 529 is
upstream (Anthropic capacity), transient, and **stateless** — the request simply
didn't complete. The problems are entirely in how we handle it:

1. **No visible signal while it's happening.** `runTask` in
   `agent-backend/src/agents/runtime.js` consumes the Claude Agent SDK
   (`@anthropic-ai/claude-agent-sdk` `query()`) stream; a transient API failure
   bubbles out of the `for await` loop and is reported once, late, via the
   generic `error` event. `webapp/src/chat.ts` `createEventHandler()` renders a
   non-budget error with `appendSystemLine(event.message, 'error')` — a single
   red line with the raw SDK string. During the hang the UI shows only the
   "…is working…" activity text with no indication anything is wrong.

2. **No app-level backoff, and the SDK default is too shallow.** The underlying
   Anthropic SDK auto-retries `429`/`5xx`/`529` with exponential backoff but
   defaults to only **2 retries** — insufficient for a sustained capacity event.
   We set no explicit `maxRetries`/retry policy at the `query()` boundary, so a
   brief overload can exhaust retries and fail the whole task.

3. **No clean resume for a generic failure.** Only the `budget_exceeded` path
   preserves `sessionId` and offers a one-click resume (story 020 budget work).
   A 529 mid-seeding leaves no resumable session: the seeding pipeline
   (`startSeeding` → `seedProject`) or chat task (`send` → `runAgentTask`) must
   be re-initiated from the top, and there's no button prompting the user to do
   so.

## Scope

- **Backend (`runtime.js`):** classify transient model-provider errors
  (HTTP 429 / 5xx / 529 / connection errors — match the SDK's typed error or
  status, not a string) and apply explicit exponential backoff with jitter
  before giving up. Raise the retry ceiling beyond the SDK default (e.g.
  `maxRetries` on the SDK options if supported, plus an app-level retry budget
  with a cap, e.g. ~5 attempts / ~60s total). Emit a new progress event (e.g.
  `{ type: 'notice', reason: 'provider_overloaded', attempt, nextRetryMs }`) so
  the client can show "model provider is busy, retrying…" while it backs off.
  Carry a machine-readable `reason` on the terminal `error` event for the
  overload case (mirror the `budget_exceeded` pattern) so the client can render
  a retry affordance instead of a raw string.
- **Frontend (`chat.ts` + `status.ts`):** on the new `notice`/overloaded signal,
  show a transient, non-alarming inline status ("Model provider is busy —
  retrying…") rather than leaving the activity spinner ambiguous. On a terminal
  overload error, render an actionable card (like `appendBudgetNotice`) with a
  one-click **Try again** that re-runs the *same* action — re-dispatch the chat
  task for a normal turn, or re-trigger `startSeeding()` when the failure
  happened during seeding. Make the retry path obvious so the user isn't left
  guessing whether typing "try again" will work.
- **Wait-time guidance in the copy:** the user-facing notice should set
  expectations — a 529 is transient and usually clears in seconds; the auto-retry
  handles the common case, and a manual retry after a short wait is the fallback.

## Acceptance Criteria

- [x] A transient `529`/`429`/`5xx` from the model provider triggers app-level
      exponential backoff with jitter (not just the SDK's 2 defaults), capped at
      a bounded attempt/time budget
- [x] While retrying, the chat UI shows a visible "retrying…" status, not a
      silent spinner
- [x] A terminal overload error renders an actionable **Try again** affordance
      that re-runs the correct action (chat turn vs. seeding pipeline), not a raw
      `API Error: 529` line
- [x] The overload terminal `error` event carries a machine-readable `reason`
      (e.g. `provider_overloaded`) so the client distinguishes it from a real
      agent/logic error
- [x] Backoff/retry logic is unit-tested in `runtime.test.js` with a mocked
      transient-then-success SDK stream

## Out of Scope

- Provider abstraction / multi-vendor failover (tracked separately — see the
  vendor-lock-in note in the 2026-06-11 design table; the agent-task boundary is
  the seam a future second provider would slot behind)
- Model fallback to a less-loaded tier (e.g. Haiku) on overload — a possible
  future enhancement, but it changes output quality and is a product decision
- Durable mid-task checkpointing so a generic failure resumes the exact SDK
  session (the `budget_exceeded` resume covers the budget case only)
