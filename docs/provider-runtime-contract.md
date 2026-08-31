# Provider-neutral runtime contract

This document freezes the Kuhn behavior that runtime/provider work must preserve. It accompanies [ADR 001](adr/001-provider-agnostic-runtime-foundation.md) and PLA-223.

There are two deliberately separate contracts:

1. `runAgentTask(...)` is Kuhn's application contract. It owns jobs, permissions, storage, suggestions, questions, sub-agents, budgets, conversations and UI/domain events.
2. `AgentRuntime.runTurn(...)` is the proposed execution contract. It owns only provider/model execution, normalized streaming, tool protocol, cancellation, usage, errors and canonical continuation.

The phase-one implementation under `agent-backend/src/agents/provider-runtime/` is experimental and not imported by production `runtime.js`.

## Normalized execution events

Every turn must emit provider identity first and exactly one terminal event last.

| Event | Required meaning |
| --- | --- |
| `provider` | provider, model and API identity; optional endpoint/capabilities |
| `text_delta` | one ordered incremental text fragment |
| `text` | complete text for the assistant turn; equals its ordered deltas when deltas exist |
| `tool_call` | the model attempted a call: call id, tool name and requested arguments |
| `tool_result` | matching call id/name, content and explicit `isError` |
| `done` | finish reason, normalized usage and canonical continuation |
| `error` | normalized error code/status/retryability; never followed by `done` |

`tool_call` records the model's attempt **before** Kuhn's schema validation — it is a faithful transcript of what the model requested, not a promise that the arguments are valid. The validation and execution outcome is always the matching `tool_result`: invalid arguments produce `tool_result.isError = true`, and the Kuhn tool implementation is never invoked for them. Every emitted `tool_call` is followed by exactly one matching `tool_result`.

A run of `text_delta` events must be closed by its final `text` event before a `done` terminal. An `error` terminal may legally interrupt an open delta run: a mid-stream provider failure is reported as the error it is, not additionally as a delta-closure violation.

A turn whose `AbortSignal` is already aborted before execution still emits provider identity first, then exactly one terminal `error` with `code: 'cancelled'` — and must not start a provider request or execute a tool.

Provider-native session/response ids are optional diagnostics and cache hints. They are not canonical continuation.

## Canonical continuation

`done.continuation` and `runTurn({continuation})` carry only the versioned, Kuhn-owned schema defined in `provider-runtime/continuation.js` — never raw provider or framework messages. Version 1 is:

```
{ version: 1, messages: [
  { role: 'user',        content: [{ type: 'text', text }] },
  { role: 'assistant',   content: [{ type: 'text', text } | { type: 'tool_call', id, name, arguments }] },
  { role: 'tool_result', toolCallId, toolName, content: [{ type: 'text', text }], isError },
] }
```

Adapters convert their framework messages to and from this shape at the runtime boundary. The validator rejects unknown versions, unknown roles/block types and any non-canonical field, so provider metadata (api/provider/model ids, response ids, usage, stop reasons, timestamps) structurally cannot leak into persisted state. Deliberate phase-one exclusions:

- **Reasoning/thinking blocks and signatures** are dropped. Consequence: a resumed conversation re-derives reasoning instead of replaying it, and providers that require reasoning replay may lose continuity. A portable reasoning policy is PLA-230.
- **Images** are excluded because phase-one `runTurn` input is text-only.
- **Provider session/cache ids** may be kept by adapters as optional metadata but are never correctness-critical canonical state.

This schema proves the phase-one contract: state produced by one runtime instance survives JSON serialization and resumes in a fresh instance, and the scripted runtime consumes the identical representation. It is **not** yet the full production continuation story — durable persistence, mid-migration provider switching and reasoning policy remain PLA-230.

## Normalized errors

Adapters map provider failures to:

- `rate_limit`
- `overloaded`
- `server`
- `network`
- `timeout`
- `cancelled`
- `context_overflow`
- `provider_error`

The category is evidence for Kuhn's retry/circuit-breaker policy; it does not itself perform product retries.

## Usage

The neutral fields are:

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `totalTokens`

Each field is a finite number or `null`. `null` means the provider did not report the field; it is not converted to zero, and an explicitly reported zero is preserved as `0` — including in the derived total: if at least one component is known, `totalTokens` is the sum of known components even when that sum is zero. `null` totals appear only when nothing was reported at all, and a provider-reported total always wins over derivation.

The four component fields are **disjoint**: `inputTokens` counts non-cached input, and the cache fields count cached input separately, so the derived total is a plain sum. Adapters own that invariant — providers that report cached tokens as a subset of input (OpenAI-style `cached_tokens`) must be converted to disjoint fields before the contract sees them; Pi's model layer already normalizes this way. Dollar/cost reconciliation is out of scope until PLA-233. Claude-specific cache field names are adapter details.

## Product-behavior evidence

The phase-one suite has two deliberately different layers. Only the first is provider-neutral.

**Layer 1 — portable contract tests** (`provider-runtime/contract.test.js`, `pi-adapter.test.js`, the scripted runtime and the Pi faux runtime). These cover streaming, tool protocol, errors, cancellation, canonical continuation and usage, and are written against the neutral event contract only. A future adapter must pass this layer unchanged.

**Layer 2 — current Kuhn application regression evidence** (existing `agents/runtime.test.js`, storage, suggestion, question, job, seeding and route tests). These freeze product behavior, but many of them assert against Claude-shaped mechanisms — `sdkQuery` options, `mcp__kuhn__*` tool names, SDK/MCP construction. They are transitional adapter tests: they prove today's behavior on today's runtime, and they **cannot run unchanged against a future non-Claude runtime**. Application-level provider-neutralization happens when PLA-226 (Kuhn-owned tool registry) and PLA-227 (real `AgentRuntime` seam under `runAgentTask`) move those policies above the adapter boundary; the table below is the map of which behaviors that work must carry over.

| Behavior | Current evidence |
| --- | --- |
| ordered delta → final text → terminal event | `provider-runtime/contract.test.js`, `pi-adapter.test.js`, `agents/runtime.test.js` |
| terminal error without done | provider-runtime tests; runtime budget/provider-error tests |
| attempted tool_call, schema validation in tool_result, execution and continuation | Pi adapter tests |
| thrown tool failures become error results | Pi adapter tests and existing runtime domain-tool tests |
| only role-granted tools are exposed | runtime allowlist and per-tool grant tests |
| compose mode removes mutating tools | runtime compose-mode tests |
| seeding bypass versus suggestion mode | runtime suggestion/seeding tests and `agents/seeding.test.js` |
| all file IO uses Kuhn storage | runtime storage-routing test and `storage.test.js` |
| traversal/absolute/cross-project/symlink escape blocked | `storage.test.js` |
| protected draft writes become pending suggestions | runtime suggestion tests and `pending-edits.test.js` |
| effective/proposed reads after a suggestion | runtime pending-proposal read tests and `pending-edits.test.js` |
| successful proposal is not reported as failed | runtime suggestion success-message tests |
| `ask_user`, reply, timeout and teardown | runtime and `questions.test.js` |
| disconnect/detach/reconnect | runtime, runs, questions and route tests |
| cancellation reaches provider and job state | Pi abort test; runtime and seeding cancellation tests |
| sub-agent role, parent, attribution, shared budget and progress | runtime dispatch/user/budget tests and `db/jobs.test.js` |
| max dispatch depth | explicit `dispatch_agent product contract` regression in `runtime.test.js` |
| normalized rate-limit/overload/server/network/timeout/cancel/context failures | provider-runtime contract tests |
| budget cutoff and weighted shared budget | runtime budget tests |
| conversation and tool audit logging | runtime and DB conversation tests |
| canonical continuation across turns, instances and runtime implementations | scripted and Pi continuation tests |
| citation/comment/project-config events | existing runtime domain-tool tests |
| job start/running/done/error transitions | runtime and DB job tests |

## Contract command

```bash
cd agent-backend
npm run test:runtime-contract
```

The command is credential-free and network-free. It runs the neutral structural suite and the Pi adapter against Pi's deterministic faux provider.

## Live evidence command

```bash
cd agent-backend
OPENROUTER_API_KEY=... npm run smoke:pi-runtime
```

The smoke uses a non-Anthropic model by default and prints provider/model/API, delta count, usage and contract violations. It never prints the credential. Override the allowlisted test model with `KUHN_PI_SMOKE_MODEL`.

## Deliberately incomplete adapter

`validateRuntimeEventSequence(...)` returns violations rather than throwing. The contract test feeds it an incomplete transcript with dangling deltas, an unresolved tool call, and no canonical continuation and asserts that every defect is detected, including provider metadata leaking into continuation state. This keeps the test suite green while proving that an incomplete adapter cannot satisfy the contract.

## Production Pi adapter (STH-8)

`provider-runtime/pi-adapter.js` replaces the phase-one spike as the Pi implementation of this contract. One module owns the whole Pi boundary: the `PiAgentRuntime` class, the canonical-continuation converters, and the provider factories (`createFauxPiRuntime`, `createOpenAICompatiblePiRuntime`, `createOpenAIPiRuntime`, `createOpenRouterPiRuntime`). `pi-spike.js` is retired; no second Pi implementation exists.

Design decisions the STH-1/STH-7 AgentRuntime seam should know:

- **Request-scoped state.** Each `runTurn` builds a fresh Pi `Agent` seeded only from the canonical continuation passed for that turn (or the constructor's initial continuation). An adapter instance holds configuration only, so concurrent turns — on one instance or across many — cannot interfere.
- **Server-mode safety.** Only tools Kuhn passed reach the model (Pi's coding-agent tool factories are never instantiated); the model-facing system prompt is exactly Kuhn's (no AGENTS.md/CLAUDE.md or implicit Pi context); credentials resolve only from explicitly named environment variables, and an unconfigured provider fails the turn with a normalized `provider_error` instead of borrowing ambient credentials. `pi-adapter.test.js` proves all three against the model-facing request context.
- **Cancellation.** A pre-aborted `AbortSignal` yields identity plus one terminal `cancelled` error with no provider work or tool execution. A mid-run abort maps to a terminal `cancelled` error even when Pi surfaces it as a provider-level `error` stop — an abort can surface through Pi-internal setup steps with the abort context lost, and the adapter reclassifies on the caller's aborted signal (the contract's required strong signal). Kuhn tools receive the turn's `AbortSignal` as Pi's documented third `execute` argument.
- **Retries.** Pi's transport-level request retry defaults to zero in the pinned 0.84.2 APIs, so provider failures surface as exactly one terminal `error` event; no retry policy lives in the adapter.
- **Identity.** `runtime.identity` exposes the normalized provider/model/api/endpoint/capabilities payload, identical to the opening `provider` event.
- **Dependencies.** The pinned `@earendil-works/pi-agent-core`/`@earendil-works/pi-ai` packages moved from devDependencies to dependencies (pins unchanged) because the adapter is production code under `src/`; a production `npm ci --omit=dev` must keep resolving them once the seam imports it.

Wiring is a one-line choice at the seam: build a `PiAgentRuntime` via a factory and consume `runTurn({ input, signal, continuation })` exactly like `ScriptedRuntime`.

The live-smoke default model moved from `openai/gpt-oss-20b:free` to `openai/gpt-oss-20b`: the free slug is retired on OpenRouter (verified 404, August 2026); the live smoke was re-verified against the new slug with zero contract violations.

STH-8 was verified against the STH-1/STH-7 AgentRuntime evolution (working-tree `contract.js` + `claude-runtime.js` reference implementation, inspected 2026-08-30): the adapter accepts the per-turn `systemPrompt` (overrides the constructor default) and `resume` (forwarded as Pi's `sessionId` — an opaque caller-side session token for prompt-cache correlation; Pi invents none of its own), exposes `cancel()` (interrupts the in-flight turn; the terminal is still one `error` with code `cancelled`), omits `kind: 'provider_builtin'` and execute-less tool descriptors from the model surface (mirroring `buildClaudeToolSet`), translates Kuhn's never-throwing failure envelope (`isError: true`) into Pi's throw-based error marking, and carries cumulative `usage` plus the partial canonical `continuation` into every error terminal. The full Pi adapter suite (76 tests) passes unchanged against the evolved `contract.js`.

Remaining seam-side decision: the Pi adapter validates tool arguments with Pi's JSON-schema path; once STH-1's `agents/tools/validate.js` lands, switching the adapter's tool wrapper to `validateArgs(parameters, args)` gives verdict parity with the Claude path (one-line change; the descriptor contract is unchanged).

## Known phase-one gaps

- Production `runAgentTask(...)` still consumes Claude SDK events directly; PLA-227 introduces the real interface.
- Kuhn tool definitions are still Claude/Zod wrappers in `runtime.js`; PLA-226 extracts the neutral registry.
- Canonical continuation proves structural portability, not production migration: durable persistence, provider switching mid-conversation and a portable reasoning/thinking policy remain PLA-230.
- Dispatch remains a Kuhn-owned product tool; the existing app-level regression must move unchanged with the neutral tool registry.
- Provider-specific structured output, reasoning visibility, images and compatibility profiles need explicit production policy.
- Scientific-writing quality parity is tracked separately in PLA-251.
