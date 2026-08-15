# Provider-neutral runtime contract

This document freezes the Kuhn behavior that runtime/provider work must preserve. It accompanies [ADR 001](adr/001-provider-agnostic-runtime-foundation.md) and PLA-223.

There are two deliberately separate contracts:

1. `runAgentTask(...)` is Kuhn's application contract. It owns jobs, permissions, storage, suggestions, questions, sub-agents, budgets, conversations and UI/domain events.
2. `AgentRuntime.runTurn(...)` is the proposed execution contract. It owns only provider/model execution, normalized streaming, tool protocol, cancellation, usage, errors and portable continuation.

The phase-one implementation under `agent-backend/src/agents/provider-runtime/` is experimental and not imported by production `runtime.js`.

## Normalized execution events

Every turn must emit provider identity first and exactly one terminal event last.

| Event | Required meaning |
| --- | --- |
| `provider` | provider, model and API identity; optional endpoint/capabilities |
| `text_delta` | one ordered incremental text fragment |
| `text` | complete text for the assistant turn; equals its ordered deltas when deltas exist |
| `tool_call` | validated call id, granted tool name and arguments |
| `tool_result` | matching call id/name, content and explicit `isError` |
| `done` | finish reason, normalized usage and portable continuation messages |
| `error` | normalized error code/status/retryability; never followed by `done` |

Provider-native session/response ids are optional diagnostics and cache hints. They are not canonical continuation.

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

Each field is a finite number or `null`. `null` means the provider did not report the field; it is not converted to zero. Claude-specific cache field names are adapter details.

## Product-behavior freeze

The phase-one suite combines new provider-neutral tests with existing Kuhn application tests. Later adapters must pass both layers unchanged.

| Behavior | Current evidence |
| --- | --- |
| ordered delta → final text → terminal event | `provider-runtime/contract.test.js`, `pi-spike.test.js`, `agents/runtime.test.js` |
| terminal error without done | provider-runtime tests; runtime budget/provider-error tests |
| tool request, schema validation, execution, result and continuation | Pi spike tests |
| thrown tool failures become error results | Pi spike tests and existing runtime domain-tool tests |
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
| continuation across turns without canonical provider session id | scripted and Pi continuation tests |
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

`validateRuntimeEventSequence(...)` returns violations rather than throwing. The contract test feeds it an incomplete transcript with dangling deltas, an unresolved tool call, and no portable continuation and asserts that every defect is detected. This keeps the test suite green while proving that an incomplete adapter cannot satisfy the contract.

## Known phase-one gaps

- Production `runAgentTask(...)` still consumes Claude SDK events directly; PLA-227 introduces the real interface.
- Kuhn tool definitions are still Claude/Zod wrappers in `runtime.js`; PLA-226 extracts the neutral registry.
- Dispatch remains a Kuhn-owned product tool; the existing app-level regression must move unchanged with the neutral tool registry.
- Provider-specific structured output, reasoning visibility, images and compatibility profiles need explicit production policy.
- Scientific-writing quality parity is tracked separately in PLA-251.
- The checked-out `main` baseline currently lacks `src/db/knowledge-catalog.js` and `src/routes/knowledge.js`, so the full backend suite has two unrelated import-failing suites even though all other suites pass.
