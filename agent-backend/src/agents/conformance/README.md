# Application conformance harness (STH-5)

Provider-neutral tests for Kuhn's **application-level behavioral contract** —
the layer between "the model said something" and "the product did something".
Built for the Pi migration: the same scenario suite must pass against Claude
(pre-migration) and Pi (post-migration) to answer *"does the new runtime
preserve Kuhn's behavior?"*

```
npm test                                      # runs everything, token-free
npx vitest run src/agents/conformance/        # conformance suite only
```

No network. No model quota. No provider credentials. The only networked
services the app touches (PubMed/ArXiv HTTP, the Docker sandbox) are replaced
by fixture-driven fakes; every Kuhn domain module (storage, pending edits,
references, comments, jobs, conversations, org knowledge, questions, budgets,
retry loop, teardown) is **real**, running against an in-memory SQLite DB with
unique temp project roots.

## What is real and what is scripted

| Layer | Status |
| --- | --- |
| `runAgentTask()` (agents/runtime.js) | **real, unmodified** |
| All Kuhn tool handlers, tool grants, compose-mode denials | real |
| Storage containment, pending edits, references, comments, jobs | real |
| Retry loop, budget accounting, question registry, teardown | real |
| PubMed/ArXiv search + efetch + registry fetch, Docker sandbox | fixture fakes (`fakes.js`) |
| The model | **scripted** — deterministic turns per scenario |

The seam at which the model is scripted is the **provider boundary of the
production code at this commit**: `@anthropic-ai/claude-agent-sdk`'s
`query()`. `mock-sdk.js` replaces that module with a bridge registry; the
active **driver** (installed per scenario by `harness.js`) supplies the model.

## Scenario suite

Scenarios are plain data (`scenarios/app-behavior.js`, `scenarios/lifecycle.js`):
a role, an input, a scripted model (turns of tool calls / text / usage, with
retry attempts), optional fixtures (files, literature, arXiv records, sandbox
scripts, org knowledge), and provider-neutral assertions on **domain events +
DB state**. No scenario references Claude SDK message shapes, `sdkQuery`, or
`mcp__kuhn__*` names — tool calls use Kuhn registry names, so the same file
runs unchanged under both drivers.

Coverage (20 scenarios):

- streaming text and final text; terminal events normalized per run
- role tool grants (denied call → error result, run completes)
- compose-mode mutation denial
- project storage containment
- direct vs proposed edits (pending edits, approve/deny paths)
- citations/references (PubMed, registry-fetched arXiv, manual identifier-less,
  corrections, live citation events — the STH-49 contract)
- comments lifecycle with cross-role attribution
- project config save; org knowledge search
- ask_user flow; detach/reconnect; teardown; cancellation/disconnect
- retry on transient error; non-transient error terminal
- job/conversation state; continuation/follow-up
- nested sub-agent dispatch with parent/child/user attribution
- active-document inheritance to dispatched children
- max dispatch depth; shared budget across parent+child
- a deliberately broken runtime (`scenarios/broken.js`) **must fail** the
  suite — the negative proof the harness catches an incomplete runtime

## The two production drivers

| Driver | Module | What it runs |
| --- | --- | --- |
| `claude` | `drivers/claude.js` (`createClaudeBridge`) | Scripted Claude-SDK-shaped turns replayed through the bridge — the pre-migration baseline behavior |
| `pi` | `drivers/pi.js` (`createPiBridge`) | The **real Pi runtime** (`provider-runtime/pi-spike.js`, `createFauxPiRuntime` with a deterministic faux model) whose normalized events (`provider-runtime/contract.js`) are translated into the SDK-shaped stream the app consumes |

`conformance.test.js` asserts: full suite passes on `claude`, full suite
passes on `pi`, and both drivers produce **identical objective results**
(per-scenario check outcomes, terminal events, job state, usage totals). The
Pi driver records raw contract.js event streams verbatim in
`bridge.transcripts` for inspection.

## Registering a runtime with the harness

A driver is a module that exports `createXBridge(scenario)` returning
`{ name, kind, observations, transcripts, query(args, mockState) }`, where
`query()` returns an async iterable (with `interrupt()`) speaking the message
protocol the production seam consumes. `harness.js` installs one bridge per
scenario (`installBridge`); `mock-sdk.js` routes the app's `query()` call to
it. Scenarios, assertions, and the suite runner are driver-agnostic.

### Claude (current)

`drivers/claude.js` — nothing to register; it is the baseline. After STH-7
makes `provider-runtime/claude-runtime.js` the production seam, the SDK mock
moves one level **below** the real Claude adapter (which imports the SDK), so
the driver keeps working unchanged and additionally exercises the adapter's
real SDK→contract event translation.

### Pi (current)

`drivers/pi.js` — consumes `createFauxPiRuntime()` from
`provider-runtime/pi-spike.js`. The scripted model comes from
`scenario.tasks[].model` (turns → `fauxAssistantMessage`/`fauxToolCall`
responses; a faux `error` stop-reason for provider failures).

**When STH-8 lands** (`pi-spike.js` → `pi-adapter.js`): change the import on
the `createFauxPiRuntime` line in `drivers/pi.js` from `pi-spike.js` to
`pi-adapter.js`. STH-8 keeps the export and its signature
(`{ responses, tools, systemPrompt, provider, continuation }` →
`{ runtime, faux, models }`); the `PiAgentRuntime` constructor is identical
to the spike's, and the driver only consumes the frozen contract.js event
protocol, so no other change is expected. Verify by running the conformance
suite (the driver's own transcript recording makes any event-protocol drift
visible).

### Pi (after the full cutover)

Once the production runtime factory selects the Pi `AgentRuntime` (contract.js
`runTurn`) instead of the Claude SDK, re-point the seam: `conformance.test.js`
mocks the runtime-factory module instead of the SDK, and `drivers/pi.js`
yields contract.js events directly (dropping the SDK-shape translation — its
raw transcript is already contract-native). The Claude driver becomes the real
`createClaudeRuntime` plus the same scripted-model plumbing. Scenario and
assertion files do not change at any step — that invariant is the design
point of this harness.

### Adding a third runtime

1. Implement the `AgentRuntime` contract (`provider-runtime/contract.js`:
   normalized streaming events, exactly one terminal event, canonical
   continuation in/out).
2. Add `drivers/<name>.js` with `createXBridge(scenario)` (SDK-seam era) or a
   `runTurn` adapter (post-cutover).
3. Add one `it(...)` in `conformance.test.js` running `runSuite` with your
   bridge and `assertSuitePasses` — the whole 20-scenario suite plus the
   negative proof runs against it with no further work.

## Layout

```
conformance/
├── conformance.test.js   # suite entry: claude / pi / parity / broken-runtime
├── harness.js            # scenario runner: seed, bridge, runAgentTask, ctx
├── assertions.js         # check recorder + driver observation context
├── mock-sdk.js           # vi.mock target for the SDK (bridge registry)
├── fakes.js              # fixture fakes: search, sandbox, efetch, arXiv API
├── env.js                # pinned conformance config (in-memory DB, temp roots)
├── result.js             # per-run result normalization for cross-driver parity
├── drivers/
│   ├── claude.js         # scripted Claude-SDK-shaped bridge
│   ├── pi.js             # real Pi runtime bridge (faux model)
│   └── error-rendering.js # shared provider-error rendering for both bridges
└── scenarios/
    ├── index.js          # SCENARIOS export
    ├── app-behavior.js   # 13 product-behavior scenarios
    ├── lifecycle.js      # 7 ask_user/retry/cancel/continuation scenarios
    └── broken.js         # the deliberately broken runtime (negative proof)
```
