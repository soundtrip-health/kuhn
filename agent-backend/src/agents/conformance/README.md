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
| `createAgentRuntime()` (provider-runtime/factory.js) | **real, unmodified** |
| `ClaudeAgentRuntime` adapter (provider-runtime/claude-runtime.js) | **real** (the Claude driver scripts the SDK below it) |
| `PiAgentRuntime` adapter (provider-runtime/pi-adapter.js) | **real** (the Pi driver scripts the model below it) |
| All Kuhn tool handlers, tool grants, compose-mode denials | real |
| Storage containment, pending edits, references, comments, jobs | real |
| Retry loop, budget accounting, question registry, teardown | real |
| PubMed/ArXiv search + efetch + registry fetch, Docker sandbox | fixture fakes (`fakes.js`) |
| The model | **scripted** — deterministic turns per scenario |

The app post-#94 consumes the normalized provider-runtime contract from
whichever `AgentRuntime` the production factory builds; it no longer imports
a provider SDK directly. Each driver scripts the **model below the real
adapter**:

- the Claude driver replaces `@anthropic-ai/claude-agent-sdk` (the module the
  real `ClaudeAgentRuntime` imports) with the `mock-sdk.js` bridge registry;
- the Pi driver replaces the Pi provider constructors that the production
  factory imports (`provider-runtime/factory.js` → `pi-adapter.js`) with the
  `mock-pi-adapter.js` scripted factory, and hands the factory the real
  `PiAgentRuntime` built on a deterministic faux model.

## Scenario suite

Scenarios are plain data (`scenarios/app-behavior.js`, `scenarios/lifecycle.js`):
a role, an input, a scripted model (turns of tool calls / text / usage, with
retry attempts), optional fixtures (files, literature, arXiv records, sandbox
scripts, org knowledge), and provider-neutral assertions on **domain events +
DB state**. No scenario references Claude SDK message shapes, `sdkQuery`, or
`mcp__kuhn__*` names — tool calls use Kuhn registry names, so the same file
runs unchanged under both drivers. Where the two providers legitimately differ
(Pi has no provider-side sessions), assertions branch on `ctx.driver.kind`.

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
| `claude` | `drivers/claude.js` (`createClaudeBridge`) | The **real `ClaudeAgentRuntime`** with a scripted Claude-SDK-shaped model replayed through the SDK bridge — the baseline behavior |
| `pi` | `drivers/pi.js` (`createPiDriver`) | The **real `PiAgentRuntime`** (`provider-runtime/pi-adapter.js`, `createFauxPiRuntime` with a deterministic faux model), built by the real production factory exactly as a `KUHN_AGENT_RUNTIME=pi` deployment would build it |

Neither driver translates provider events into the other provider's message
shape: the app consumes the normalized contract from both, and each driver's
`transcripts` record the raw contract.js event stream of the real adapter.

`conformance.test.js` asserts: full suite passes on `claude`, full suite
passes on `pi`, and both drivers produce **identical objective results**
(per-scenario check outcomes, terminal events, job state, usage totals — the
Pi driver feeds the same declared per-turn tokens to its faux model).

## Registering a runtime with the harness

A driver is a module that exports `createX(scenario)` returning
`{ name, kind, observations, transcripts, ... }` plus one of:

- `query(args, mockState)` (Claude-side drivers): an async iterable (with
  `interrupt()`) speaking the Claude-SDK message protocol, installed via
  `mock-sdk.js`'s `installBridge`; or
- `buildRuntime(options)` (Pi-side drivers): returns `{ runtime }` — a real
  `AgentRuntime` (contract.js) whose model is scripted — installed via
  `mock-pi-adapter.js`'s `installPiFactory` in place of the Pi provider
  constructors.

`harness.js` installs the matching seam per scenario (and resets both, plus
the runtime selector, between scenarios). Scenarios, assertions, and the
suite runner are driver-agnostic.

### Adding a third runtime

1. Implement the `AgentRuntime` contract (`provider-runtime/contract.js`:
   normalized streaming events, exactly one terminal event, canonical
   continuation in/out) and a provider factory in
   `provider-runtime/factory.js`.
2. Add `drivers/<name>.js` whose `createX(scenario)` builds a real adapter
   over a scripted model, and register its factory replacement in
   `conformance.test.js` (vi.mock of the adapter module's provider
   constructors, as the Pi driver does).
3. Add one `it(...)` in `conformance.test.js` running `runSuite` with your
   driver and `assertSuitePasses` — the whole 20-scenario suite plus the
   negative proof runs against it with no further work.

## Layout

```
conformance/
├── conformance.test.js   # suite entry: claude / pi / parity / broken-runtime
├── harness.js            # scenario runner: seed, driver seams, runAgentTask, ctx
├── assertions.js         # check recorder + driver observation context
├── mock-sdk.js           # vi.mock target for the Claude SDK (bridge registry)
├── mock-pi-adapter.js    # vi.mock target for the Pi provider constructors
├── fakes.js              # fixture fakes: search, sandbox, efetch, arXiv API
├── env.js                # pinned conformance config (in-memory DB, temp roots)
├── result.js             # per-run result normalization for cross-driver parity
├── drivers/
│   ├── claude.js         # scripted Claude-SDK-shaped model (real Claude adapter)
│   ├── pi.js             # scripted faux model (real Pi adapter + factory)
│   └── error-rendering.js # shared provider-error rendering for both drivers
└── scenarios/
    ├── index.js          # SCENARIOS export
    ├── app-behavior.js   # 13 product-behavior scenarios
    ├── lifecycle.js      # 7 ask_user/retry/cancel/continuation scenarios
    └── broken.js         # the deliberately broken runtime (negative proof)
```
