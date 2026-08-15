# ADR 001: Provider-agnostic runtime foundation

- **Status:** Accepted for phased implementation
- **Date:** 2026-08-14
- **Issues:** PLA-222, PLA-223
- **Decision owners:** Kuhn maintainers

## Context

Kuhn currently executes every agent through `@anthropic-ai/claude-agent-sdk`. That implementation is working and remains the quality/reference path during the migration, but provider-specific protocol details and Kuhn product policy share one large module. Replacing the SDK wholesale would risk silently losing behavior that users already depend on.

The governing principle is:

> Kuhn owns product semantics. A runtime/provider library supplies model execution primitives only.

`runAgentTask(...)` remains the application boundary. Jobs, conversations, attribution, permissions, project/org isolation, storage, suggestions, comments, citations, questions, budgets, sub-agent policy, deterministic seeding, and UI events remain Kuhn-owned.

PLA-224 and PLA-225 add constraints that apply to this decision even though their broader production work is out of scope here:

- provider credentials and egress must be explicitly scoped and must never become model-selectable tenant data;
- no adapter may receive unrestricted filesystem or shell access;
- the initial single-process topology does not make in-memory provider continuation durable;
- portable continuation must be persisted as Kuhn-owned messages rather than an opaque provider session id;
- a future worker/sandbox split must not require changing product-level runtime semantics.

## Current Claude coupling

The direct dependency is concentrated in `agent-backend/src/agents/runtime.js`, but it covers more than a chat completion:

| Current behavior | Claude-specific mechanism | Kuhn behavior that must remain above the seam |
| --- | --- | --- |
| Model execution | `query(...)`, Claude model ids, max turns | role/model selection and policy |
| Streaming | SDK `stream_event` / Anthropic content deltas | ordered `text_delta`, final `text`, terminal events |
| Tools | SDK `tool(...)`, in-process MCP server, `mcp__kuhn__*` names | tool grants, authorization, storage and domain implementations |
| Built-in research | `WebSearch`, `WebFetch` | optional capability; not a product invariant |
| Tool transcripts | SDK assistant `tool_use` and user `tool_result` blocks | conversation audit log and UI/domain events |
| Cancellation | query iterator `interrupt()` | client disconnect, job cancellation, question teardown |
| Continuation | SDK `session_id` and `resume` | canonical conversation history and retry policy |
| Failures | SDK status/message shapes and string matching | normalized failure class and retry policy |
| Usage | Anthropic input/output plus prompt-cache fields | shared budget and provider-independent accounting |
| Sub-agents | SDK-capable loop plus Kuhn `dispatch_agent` tool | role, parent/child job, user attribution, depth and shared budget |
| Human input | long-running SDK tool handler | `ask_user`, detach/reconnect, expiry and reply authorization |

The following behaviors are already separate modules and are not candidates for relocation into Pi or any other framework:

- project and org storage containment;
- pending-edit/suggestion semantics and effective reads;
- references, derived bibliography, citations and comments;
- jobs, conversations, user attribution and project feed events;
- role grants and compose-mode restrictions;
- deterministic seeding;
- question/reply and detachable-run registries;
- tenant membership, suspension and super-admin separation.

## Requirements

The execution kernel must support:

1. text and token/delta streaming;
2. caller-supplied tools only, with JSON-schema validation and error results;
3. tool-call/result loops;
4. `AbortSignal` cancellation;
5. serializable, provider-portable conversation continuation;
6. direct non-Anthropic providers;
7. configurable OpenAI-compatible endpoints;
8. provider/model/capability identity;
9. normalized usage including explicit missing fields;
10. deterministic fake/scripted providers;
11. different model profiles by Kuhn role;
12. a small adapter surface that can be removed later.

The kernel must not own Kuhn jobs, storage, authorization, credentials, suggestions, comments, citations, questions, budgets, deterministic orchestration, or sub-agent policy.

## Candidates

### Pi core/model primitives

Evaluated packages:

- `@earendil-works/pi-ai` 0.84.2
- `@earendil-works/pi-agent-core` 0.84.2

The older `@mariozechner/*` packages resolve to 0.73.1 but are deprecated on npm in favor of the `@earendil-works/*` scope. The spike therefore uses the successor scope, not the initially expected package names.

Both selected packages are MIT-licensed, publish from the same public repository, and list multiple npm maintainers. They were actively published on the decision date; that is positive maintenance evidence but also means a fast-moving API surface. Exact pins and the adapter boundary are required safeguards, not optional conservatism.

Pi provides a model/provider collection, provider factories, a low-level agent loop and stateful `Agent`, TypeBox tool schemas, ordered lifecycle events, abort, portable message state, OpenAI-compatible configuration flags, capability metadata, and an in-memory faux provider.

This decision does **not** adopt Pi's coding-agent product, UI, filesystem/shell tools, session backends, or opinionated coding environment.

### Vercel AI SDK Core with a Kuhn-owned loop

Evaluated versions:

- `ai` 7.0.66
- `@ai-sdk/openai-compatible` 3.0.30

AI SDK Core is a credible alternative. It provides streaming, tool calls, Zod compatibility, abort, provider metadata, OpenAI-compatible endpoints, and test mocks. It is thinner and would let Kuhn reuse its existing Zod schemas more directly. Kuhn would, however, own more of the multi-step agent loop, continuation semantics, capability catalog, tool lifecycle normalization and provider-compatibility handling.

### Fully Kuhn-owned loop over provider SDKs

This offers maximal control and the smallest conceptual lock-in, but requires Kuhn to implement and continually maintain cross-provider streaming, tool formats, reasoning blocks, usage, errors, compatibility quirks and model metadata. That duplicates exactly the volatile layer this migration is intended to isolate.

## Experimental evidence

The isolated spike lives under `agent-backend/src/agents/provider-runtime/`. It is not imported by production `runtime.js`.

Automated evidence (`npm run test:runtime-contract`):

- ordered text deltas, final text and terminal state;
- provider/model/API/capability identity;
- TypeBox tool-argument validation;
- caller-supplied tool execution, result return and model continuation;
- thrown tool errors represented as error results;
- cancellation propagated through `AbortSignal` to Pi;
- continuation across user turns with serialized messages and no opaque session id;
- explicit input/output/cache/total usage normalization;
- deterministic faux-provider responses;
- normalized provider failure categories;
- configurable OpenAI-compatible model/provider construction without credentials or network;
- unsafe endpoint forms rejected before provider construction;
- an intentionally incomplete adapter rejected by the structural contract.

Live evidence (`npm run smoke:pi-runtime`):

- provider: OpenRouter;
- underlying non-Anthropic model: `openai/gpt-oss-20b:free`;
- API shape: `openai-completions`;
- token streaming: 4 deltas;
- usage: 92 input, 38 output, 130 total;
- contract violations: none;
- no Anthropic credential was used.

The first live attempt exposed a real capability difference: the selected reasoning model rejected requests when reasoning was disabled. The spike now derives a default Pi thinking level from model capability metadata. Production profiles must make this explicit rather than assume one reasoning policy fits every model.

## Comparison

| Criterion | Pi core/model | AI SDK Core + Kuhn loop | Kuhn-owned provider loop |
| --- | --- | --- | --- |
| Provider breadth | Broad built-in catalog | Broad through separate provider packages | Only what Kuhn implements |
| OpenAI-compatible endpoints | First-class model/provider plus detailed compatibility flags | First-class compatible provider | Full custom work |
| Tool normalization | TypeBox schemas and lifecycle hooks | Zod/JSON schema tools, step hooks | Full custom work |
| Streaming normalization | Model and agent event protocols | Text/tool stream protocol | Full custom work |
| Abort | `AbortSignal` and `Agent.abort()` | `AbortSignal` | Must implement per SDK |
| Portable continuation | Serializable messages and `Agent.continue()` | Manual accumulated messages | Must design and implement |
| Caller-supplied tools only | Yes | Yes | Yes |
| Capability metadata | Strong model metadata and compatibility flags | Provider metadata; more app-owned catalog work | Entirely app-owned |
| Deterministic fake | Scripted faux provider | Mock model/provider utilities | Must implement |
| Framework lock-in | Moderate, contained by adapter | Low-to-moderate | Low |
| API/dependency surface | Larger; multi-provider SDK dependencies | Smaller core, provider packages selected separately | Small initially, high maintenance surface |
| Current Node requirement | >=22.19 | >=22 | Kuhn choice |
| Escape hatch | Strong if Pi messages stay behind contract | Strong | N/A |

## Decision

Adopt **Pi's lower-level model and agent-core primitives** as the planned execution kernel beneath a Kuhn-owned `AgentRuntime` adapter.

The production architecture will be:

```text
routes / UI
    |
runAgentTask(...)                Kuhn application boundary
    |  jobs, auth, storage, suggestions, questions, budgets, sub-agents
Kuhn AgentRuntime interface      normalized execution boundary
    |
Pi adapter                       model loop, deltas, tool protocol, abort, usage
    |
provider / custom endpoint
```

The current Claude Agent SDK implementation remains intact as the transitional/reference runtime until the later migration issues prove behavioral and writing-quality parity. This ADR does not remove Anthropic support or complete provider independence.

Pi wins because it supplies the volatile execution primitives while still allowing Kuhn to inject only explicitly granted tools and retain ownership of every product policy. Its faux provider and serializable messages materially reduce migration and test risk. AI SDK Core remains the fallback if Pi's package stability, dependency weight or server-suitability proves unacceptable during PLA-228.

## Package and version policy

- Pin the spike packages exactly at 0.84.2; do not use caret ranges before production parity.
- Keep them as dev dependencies while the adapter is experimental and not imported by production.
- Require Node >=22.19 for spike development. Before Pi enters production dependencies, align root/backend runtime documentation and CI on a supported LTS (currently Node 24 is recommended).
- Update Pi only in dedicated dependency changes that run contract, live-provider and quality baselines.
- Record package-scope or maintainer changes explicitly. The 2026 move from `@mariozechner` to `@earendil-works` demonstrates why floating names/versions are unacceptable.
- Review dependency and license inventory before promotion: the current Pi packages pull multiple provider SDKs and add materially more dev dependencies than a single-provider adapter.
- The phase-one `npm audit` findings resolve to the same six package versions already locked on `main` (four production-path findings through the Claude/MCP dependency graph and two Vitest-path findings). Pi shares some of those transitive packages but did not add a new vulnerable version; remediation remains necessary independently of this spike.

## Capability gaps and risks

### Tool schemas

Kuhn's current Claude wrappers use Zod objects while Pi core expects TypeBox/JSON Schema. PLA-226 must create one neutral Kuhn tool definition and deterministic schema conversion/validation. Do not keep two handwritten schemas.

### Reasoning and structured output

Thinking blocks, required reasoning, reasoning-effort names, strict schemas and structured output vary by provider/model. Role profiles must select supported capabilities and degrade explicitly. Thinking content must not automatically enter Kuhn's visible transcript or audit log.

### Usage and cost

Pi supplies input/output/cache/cost fields, but provider completeness varies and local endpoints may omit streaming usage. The neutral contract preserves `null` for unreported fields. Kuhn remains responsible for budget and cost policy; reported cost is evidence, not authorization.

### Errors and retry

Pi normalizes stream termination but provider error messages/statuses still differ. The spike defines stable categories (`rate_limit`, `overloaded`, `server`, `network`, `timeout`, `cancelled`, `context_overflow`, `provider_error`). Production retry/circuit-breaker policy remains Kuhn-owned.

### Continuation

Pi can replay portable message history and also supports provider session/cache hints. Kuhn will persist portable messages as canonical state. Provider response/session ids may be stored as optional diagnostics or cache hints only.

### Model discovery and profiles

Static catalogs are convenient but can drift; dynamic discovery can be slow or expose models Kuhn has not approved. Production configuration must use allowlisted role profiles with explicit provider/model/capabilities. A model may never select credentials or an arbitrary endpoint.

### Credentials and egress

The spike resolves credentials from provider-specific environment variables. Production work must introduce tenant-safe secret storage, redaction, rotation and egress policy before organization overrides are enabled. Credentials never belong in prompts, model metadata, continuation state, logs or DB-backed agent arguments.

### OpenAI-compatible variance

Compatibility flags cover common differences, but "OpenAI-compatible" is not a complete standard. Each supported endpoint profile needs contract tests for role/system messages, tool result names, strict mode, max-token field, reasoning, images and usage.

### Multimodal input

Pi exposes text/image capability metadata and can carry images. Kuhn currently needs a separate policy for which project files may leave the system and how they are transformed; image support is not enabled merely because a model advertises it.

### Hosted web search

Provider-native search remains optional. Current `WebSearch`/`WebFetch` coupling is a known gap. Portable product behavior should use Kuhn-owned scholarly/search tools; provider search can be an explicitly declared enhancement.

### Server and dependency footprint

The direct Pi package directories are roughly 15 MB installed in this spike and include SDKs for providers Kuhn may not use. Before production promotion, measure cold start, memory and deploy artifact impact and investigate selective/lazy imports or a narrower model-layer build.

## Migration strategy

1. **PLA-222/223:** land this ADR, isolated spike, neutral contract and current-behavior evidence. Keep production Claude unchanged.
2. **PLA-226:** extract one Kuhn-owned tool registry from Claude wrappers. Preserve storage and permission invariants.
3. **PLA-227:** introduce the real `AgentRuntime` interface beneath `runAgentTask(...)` with normalized events/errors/usage.
4. **PLA-228:** implement the Pi adapter and run the same contract against Claude and Pi paths.
5. **PLA-229–233:** role profiles, portable continuation, web research, custom endpoints and accounting.
6. **PLA-251:** compare scientific-writing quality against the current Claude baseline.
7. **PLA-234:** remove the Claude Agent SDK only after two materially different providers plus a configurable compatible endpoint pass contract and quality gates.

## Escape hatch

Kuhn's interface and tests use only normalized events, portable messages, JSON-compatible schemas, provider/model identity and explicit usage fields. Pi types stay inside `provider-runtime/pi-spike.js` and the future Pi adapter. Kuhn tools and policy never import Pi.

If Pi is abandoned, replace the adapter with AI SDK Core or a Kuhn-owned loop. `runAgentTask(...)`, tools, DB schema, storage, authorization, UI events and persisted continuation remain unchanged.

## Consequences

- The migration gains evidence and a narrow target without destabilizing the current runtime.
- Node/runtime and dependency policy become explicit before production adoption.
- Provider differences become capabilities and normalized envelopes rather than string checks spread through product code.
- The project accepts a moderate model-layer dependency in exchange for substantially less provider-protocol maintenance.
- Provider independence is **not complete**. The Claude path remains production and the Pi code remains an isolated spike in this phase.

## References

- [Pi repository](https://github.com/earendil-works/pi)
- [Pi AI package](https://www.npmjs.com/package/@earendil-works/pi-ai)
- [Pi agent-core package](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
- [Vercel AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core/overview)
- [Vercel OpenAI-compatible provider](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
- [Provider-neutral contract evidence](../provider-runtime-contract.md)
