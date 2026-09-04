# Kuhn — Linear issue archive

> **Archived 2026-09-04.** Issue tracking moved to [GitHub issues](https://github.com/soundtrip-health/kuhn/issues). Open Linear items were migrated (#108–#122, plus #106/#107) or consolidated into the production-readiness tracker (#122); Done items are kept here for history. The "Linear is the source of truth" language below is historical.

Exported from Linear on 2026-09-02 (project: [Kuhn](https://linear.app/platinum-labs/project/kuhn-5d0a56941bbe), team: Sound Trip Health / STH), because the team may be transitioning away from Linear. This file is a complete archive of all 63 issues in the project, with full, untruncated descriptions.

## Project overview

## Current implementation state — 2026-08-30

`main` is `382f4a0bcd420d35752d5c07f749360c8cccb983` with no open pull requests. The provider-neutral contract, canonical continuation schema, Pi spike, knowledge-catalog repair, threat model, and deployment ADR are merged. Production `runAgentTask(...)` still uses the Claude Agent SDK; Pi is not yet reachable through normal product execution.

The active objective is a **full conversion to a Kuhn-owned Pi runtime**, not indefinite dual-runtime maintenance. Claude remains temporarily as a reference/fallback only until deterministic conformance, live provider/custom-endpoint, and scientific-writing non-inferiority gates pass. The project document **Pi transition execution plan and parallel-work protocol** is the source of truth for wave order, integration barriers, issue ownership, and same-machine agent safety.

# Kuhn

Kuhn is a collaborative, AI-assisted workspace for scientific and technical writing. It brings drafting, structured editing, research, citations, organization knowledge, review, version history, real-time collaboration, and specialized AI assistance into one place.

Source repository: [soundtrip-health/kuhn](https://github.com/soundtrip-health/kuhn)

## What we're building

Kuhn should help teams produce high-quality technical work with less coordination overhead while keeping people in control of the writing, evidence, decisions, and final output.

The project is broader than any one model provider, framework, deployment architecture, or current migration. This Linear project is the long-lived home for Kuhn product development.

## Core product areas

* **Writing & editing** — manuscript/project authoring, structured edits and suggestions, citations, formatting, history, and export.
* **AI workspace** — specialized agent roles, orchestration, model/runtime behavior, tools, prompting, and human-agent interaction.
* **Research & knowledge** — literature/web research, source handling, organization knowledge, retrieval, provenance, and reusable context.
* **Collaboration & review** — real-time editing, comments/review flows, invitations, roles, handoffs, and shared project state.
* **Organizations & administration** — membership, permissions, identity, policy, configuration, governance, and usage controls.
* **Platform quality** — security, privacy, reliability, data durability, observability, performance, testing, deployment, and release engineering.
* **Product & UX** — information architecture, workflow design, usability, accessibility, polish, and new product capabilities.

## Product principles

* **Kuhn owns the product semantics.** Model providers and agent frameworks are replaceable implementation details.
* **Human control and traceability matter.** Important edits, sources, actions, and decisions should be understandable and reviewable.
* **Collaboration is a first-class workflow.** Design for teams sharing projects, context, review, and responsibility rather than a single-user chatbot with sharing added later.
* **Scientific and technical work needs evidence.** Preserve provenance, reproducibility, citations, and explicit quality checks where they matter.
* **Real team data deserves real operational discipline.** Security, tenancy, recovery, durability, and observability are product requirements.
* **Prefer useful simplicity.** Add infrastructure or workflow complexity when it solves a demonstrated product or operational need.

## Current focus

The current major program is a 2026 modernization effort: make Kuhn model/provider-independent and harden it for sustained multi-user team operation. The milestones below organize that work, but they are **the current phase of Kuhn, not the definition of Kuhn**.

See [**2026 Modernization Program**](https://linear.app/platinum-labs/document/2026-modernization-program-3118a7cc3f01) for the architectural baseline, sequencing, and program exit criteria.

## Working together

Linear is the source of truth for roadmap, scope, status, ownership, and durable decisions; GitHub is the source of truth for code and pull-request review.

See [**Working on Kuhn**](https://linear.app/platinum-labs/document/working-on-kuhn-484f23b7db32) for the shared status convention, how to pick up work, issue quality expectations, review practice, priorities, and documentation rules.

As a rule: assign work when you start it, keep issue scope understandable without private chat context, record blockers/dependencies, and move work to **In Review** only when another contributor has something concrete to review.

## Index

| ID | Title | Status | Priority |
|---|---|---|---|
| [STH-1](#sth-1--extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers) | Extract Kuhn-owned tool registry from Claude SDK wrappers | In Review | High |
| [STH-2](#sth-2--write-production-threat-model-and-data-classification-baseline) | Write production threat model and data-classification baseline | Done | High |
| [STH-3](#sth-3--adr-define-the-production-deployment-topology-and-scale-boundary) | ADR: define the production deployment topology and scale boundary | Done | High |
| [STH-4](#sth-4--restore-missing-knowledge-catalog-modules-that-break-backend-startuptests) | Restore missing knowledge catalog modules that break backend startup/tests | Done | Urgent |
| [STH-5](#sth-5--freeze-provider-neutral-agent-behavior-with-runtime-contract-tests) | Freeze provider-neutral agent behavior with runtime contract tests | In Progress | High |
| [STH-6](#sth-6--adr--spike-choose-kuhns-provider-agnostic-runtime-foundation) | ADR + spike: choose Kuhn's provider-agnostic runtime foundation | Done | High |
| [STH-7](#sth-7--introduce-kuhn-agentruntime-interface-and-normalized-provider-envelopes) | Introduce Kuhn AgentRuntime interface and normalized provider envelopes | In Review | High |
| [STH-8](#sth-8--implement-pi-core-runtime-adapter-behind-agentruntime) | Implement Pi-core runtime adapter behind AgentRuntime | In Review | High |
| [STH-9](#sth-9--add-providermodelendpoint-profiles-with-capability-aware-per-role-routing) | Add provider/model/endpoint profiles with capability-aware per-role routing | Done | High |
| [STH-10](#sth-10--make-conversation-continuation-and-retries-provider-portable) | Make conversation continuation and retries provider-portable | Done | High |
| [STH-11](#sth-11--replace-claude-hosted-websearchwebfetch-with-kuhn-owned-research-tools) | Replace Claude-hosted WebSearch/WebFetch with Kuhn-owned research tools | Done | High |
| [STH-12](#sth-12--support-custom-openai-compatible-endpoints-and-prove-a-live-multi-provider-matrix) | Support custom OpenAI-compatible endpoints and prove a live multi-provider matrix | Backlog | High |
| [STH-13](#sth-13--normalize-token-context-cost-and-budget-accounting-across-providers) | Normalize token, context, cost, and budget accounting across providers | Done | High |
| [STH-14](#sth-14--remove-claude-agent-sdk-and-anthropic-required-configuration) | Remove Claude Agent SDK and Anthropic-required configuration | Backlog | High |
| [STH-15](#sth-15--add-owneradmin-ui-for-provider-credentials-model-profiles-and-per-role-routing) | Add owner/admin UI for provider credentials, model profiles, and per-role routing | Backlog | High |
| [STH-16](#sth-16--block-stored-active-content-attacks-from-uploaded-htmlsvg-and-raw-project-files) | Block stored active-content attacks from uploaded HTML/SVG and raw project files | In Review | Urgent |
| [STH-17](#sth-17--fail-closed-in-production-and-validate-security-critical-configuration-at-boot) | Fail closed in production and validate security-critical configuration at boot | Backlog | High |
| [STH-18](#sth-18--add-production-identity-adapter-with-oidcsso-and-hardened-session-lifecycle) | Add production identity adapter with OIDC/SSO and hardened session lifecycle | Backlog | High |
| [STH-19](#sth-19--add-rate-limits-quotas-and-abuse-controls-across-public-and-expensive-surfaces) | Add rate limits, quotas, and abuse controls across public and expensive surfaces | Backlog | High |
| [STH-20](#sth-20--add-secure-provider-credential-storage-scoping-rotation-and-redaction) | Add secure provider credential storage, scoping, rotation, and redaction | Done | High |
| [STH-21](#sth-21--isolate-and-harden-sandbox-execution-remove-web-process-docker-root-equivalent-exposure) | Isolate and harden sandbox execution; remove web-process Docker root-equivalent exposure | Backlog | High |
| [STH-22](#sth-22--replace-startup-time-ad-hoc-ddl-with-versioned-database-migrations-and-upgrade-safety) | Replace startup-time ad hoc DDL with versioned database migrations and upgrade safety | Backlog | High |
| [STH-23](#sth-23--implement-data-durability-backups-restore-drills-retention-deletion-and-export) | Implement data durability: backups, restore drills, retention, deletion, and export | Backlog | High |
| [STH-24](#sth-24--extend-tenancy-regression-coverage-and-add-a-durable-securityadmin-audit-trail) | Extend tenancy regression coverage and add a durable security/admin audit trail | Backlog | High |
| [STH-25](#sth-25--make-agent-jobs-durable-leased-cancellable-resumable-and-suspension-aware) | Make agent jobs durable, leased, cancellable, resumable, and suspension-aware | Backlog | Urgent |
| [STH-26](#sth-26--add-structured-observability-logs-metrics-traces-slos-and-provider-usage-diagnostics) | Add structured observability: logs, metrics, traces, SLOs, and provider usage diagnostics | Backlog | High |
| [STH-27](#sth-27--add-readinessliveness-graceful-shutdown-connection-draining-and-dependency-health) | Add readiness/liveness, graceful shutdown, connection draining, and dependency health | Backlog | High |
| [STH-28](#sth-28--build-ci-qualitysecurity-gates-for-backend-webapp-migrations-tenancy-and-provider-contracts) | Build CI quality/security gates for backend, webapp, migrations, tenancy, and provider contracts | In Review | High |
| [STH-29](#sth-29--create-reproducible-production-artifacts-with-automated-upgrade-and-rollback) | Create reproducible production artifacts with automated upgrade and rollback | Backlog | High |
| [STH-30](#sth-30--run-load-soak-and-failure-injection-tests-across-collaboration-agents-storage-and-providers) | Run load, soak, and failure-injection tests across collaboration, agents, storage, and providers | Backlog | High |
| [STH-31](#sth-31--build-a-cross-provider-scientific-writing-quality-benchmark-and-preserve-kuhns-current-baseline) | Build a cross-provider scientific-writing quality benchmark and preserve Kuhn's current baseline | In Progress | High |
| [STH-32](#sth-32--write-operatoradmin-runbooks-for-incidents-recovery-providers-and-user-lifecycle) | Write operator/admin runbooks for incidents, recovery, providers, and user lifecycle | Backlog | High |
| [STH-33](#sth-33--pass-the-full-staging-production-acceptance-gate) | Pass the full staging production-acceptance gate | Backlog | Urgent |
| [STH-34](#sth-34--run-a-bounded-real-team-pilot-and-make-the-production-gono-go-decision) | Run a bounded real-team pilot and make the production go/no-go decision | Backlog | High |
| [STH-35](#sth-35--remove-new-user-self-registration) | Remove new user self-registration | Done | Urgent |
| [STH-36](#sth-36--superadmin-change-orgs) | Superadmin change orgs | Done | High |
| [STH-37](#sth-37--live-external-reviewer-tags) | Live external reviewer tags | Done | No priority |
| [STH-38](#sth-38--command-help) | /command help | Done | No priority |
| [STH-39](#sth-39--comment-text-isnt-copyable) | Comment text isn't copyable | Done | High |
| [STH-40](#sth-40--clicking-comment-doesnt-scroll) | Clicking comment doesn't scroll | Done | No priority |
| [STH-41](#sth-41--small-writer-edits-modify-whole-sections) | Small writer edits modify whole sections | Done | High |
| [STH-42](#sth-42--citation-markers-should-show-context) | citation markers should show context | Done | High |
| [STH-43](#sth-43--agents-have-little-context-awareness) | agents have little context awareness | Done | High |
| [STH-44](#sth-44--writer-edits-were-not-visible-as-approvable-diff) | Writer edits were not visible as approvable diff | Done | High |
| [STH-45](#sth-45--doc-status-bar-gets-crowded) | doc status bar gets crowded | Done | High |
| [STH-46](#sth-46--this-conversation-is-getting-long) | This conversation is getting long | Done | High |
| [STH-47](#sth-47--ship-an-opt-in-end-to-end-pi-runtime-preview-with-explicit-rollback) | Ship an opt-in end-to-end Pi runtime preview with explicit rollback | In Review | High |
| [STH-50](#sth-50--chat-scroll) | chat scroll | Done | High |
| [STH-51](#sth-51--logging) | logging | Done | High |
| [STH-52](#sth-52--per-agent-current-context-state-indicator) | per-agent, current-context state indicator | Done | Medium |
| [STH-53](#sth-53--pi-review-system) | PI review system | Todo | High |
| [STH-54](#sth-54--ra-cant-read-pdfs) | RA can't read pdfs | Done | High |
| [STH-55](#sth-55--when-the-conversation-is-getting-long) | When the conversation is getting long | In Review | Medium |
| [STH-56](#sth-56--slides-with-marp) | Slides with Marp | Todo | Medium |
| [STH-57](#sth-57--marp-core-render-slide-decks-to-pdf--pptxhtml-export) | Marp core: render slide decks to PDF + PPTX/HTML export | Done | Medium |
| [STH-58](#sth-58--slide-themes-seeded-defaults--org-theme-library) | Slide themes: seeded defaults + org theme library | In Review | Medium |
| [STH-59](#sth-59--agent-slide-authoring-de-novo-decks--manuscriptslides) | Agent slide authoring: de novo decks + manuscript→slides | Backlog | Medium |
| [STH-60](#sth-60--template-from-deck-derive-a-marp-theme-from-an-uploaded-pdfpptx) | Template-from-deck: derive a Marp theme from an uploaded PDF/PPTX | Backlog | Medium |
| [STH-61](#sth-61--slide-theme-testing-follow-ups-theme-list-tool-editor-front-matter-editable-pptx) | Slide-theme testing follow-ups: theme-list tool, editor front matter, editable PPTX | In Review | High |
| [STH-62](#sth-62--sanitize-org-promotion-markdown-previews-to-prevent-stored-xss) | Sanitize org promotion Markdown previews to prevent stored XSS | Backlog | Urgent |
| [STH-63](#sth-63--comment-delete-confirmation) | Comment delete confirmation | Todo | Low |
| [STH-64](#sth-64--figure-should-be-beautiful) | Figure should be beautiful | Todo | High |
| [STH-65](#sth-65--token-limit-behavior) | Token limit behavior | Todo | High |

## In Progress

### STH-1 — Extract Kuhn-owned tool registry from Claude SDK wrappers

**Status:** In Review · **Priority:** High · **Labels:** Next Up, AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers>

## Ready to implement — 2026-08-30

The prerequisite ADR/Pi spike is merged. This is the first production-code tranche of the Pi transition and owns extraction of the Kuhn tool domain from `runtime.js`. It may run in parallel with [STH-31](https://linear.app/platinum-labs/issue/STH-31/build-a-cross-provider-scientific-writing-quality-benchmark-and), [STH-28](https://linear.app/platinum-labs/issue/STH-28/build-ci-qualitysecurity-gates-for-backend-webapp-migrations-tenancy), [STH-9](https://linear.app/platinum-labs/issue/STH-9/add-providermodelendpoint-profiles-with-capability-aware-per-role)'s profile data model, [STH-10](https://linear.app/platinum-labs/issue/STH-10/make-conversation-continuation-and-retries-provider-portable)'s canonical persistence design, [STH-11](https://linear.app/platinum-labs/issue/STH-11/replace-claude-hosted-websearchwebfetch-with-kuhn-owned-research-tools)'s standalone research client, and [STH-13](https://linear.app/platinum-labs/issue/STH-13/normalize-token-context-cost-and-budget-accounting-across-providers)'s normalized accounting module. It must publish a clear handoff before [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider) or [STH-8](https://linear.app/platinum-labs/issue/STH-8/implement-pi-core-runtime-adapter-behind-agentruntime) modifies the same `runtime.js` integration points.

## Goal

Make Kuhn tools first-class provider-neutral domain objects instead of constructing them directly with Claude SDK `tool(...)` / `createSdkMcpServer(...)` helpers inside `runtime.js`.

## Scope

* Define a Kuhn tool descriptor/executor contract: stable name, description, JSON-schema-compatible parameters, grant slug/capability, mutability classification, execute callback, result/error envelope.
* Move existing tools behind that contract without changing their product behavior: project read/list/write/edit/move, citations/references, comments, org knowledge, PubMed/arXiv, ask_user, project config, sub-agent dispatch.
* Keep `storage.js`, pending-edit policy, role grants, project/org derivation, and event publication authoritative.
* Add adapter functions so the current Claude runtime can consume the neutral registry during migration.
* Preserve compose-mode denial and seeding/suggestion semantics.

## Acceptance criteria

* Tool definitions no longer import Claude SDK types/helpers.
* Claude adapter still passes the provider-neutral contract suite.
* Tool execution is independently unit-testable with no model SDK.
* A runtime adapter can enumerate only the tools granted to the active role/mode.
* No tool can accept an org/project identity supplied by the model when Kuhn can derive it server-side.

### STH-5 — Freeze provider-neutral agent behavior with runtime contract tests

**Status:** In Progress · **Priority:** High · **Labels:** Quality & Validation, AI Runtime & Models · **Milestone:** Modernization 1 — Architecture & Contracts · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-5/freeze-provider-neutral-agent-behavior-with-runtime-contract-tests>

## Current state — 2026-08-30

Phase 1 merged in PR #69 (`9f365de828d9b9b97f77e181709add657fe1af10`): Kuhn now has a provider-neutral low-level event contract, deterministic scripted runtime, versioned canonical continuation schema, and isolated Pi spike. That is necessary evidence, but it does **not** yet satisfy this issue's full application-level acceptance criteria.

This issue is now the final shared conformance gate across the transitional Claude adapter and production Pi adapter. Completion depends on [STH-1](https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers), [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider), and [STH-8](https://linear.app/platinum-labs/issue/STH-8/implement-pi-core-runtime-adapter-behind-agentruntime). The remaining work is to run the same application-level scenarios through both adapters without asserting Claude SDK/MCP internals, covering role grants, compose mode, storage/pending edits, citations/comments/config, questions, sub-agents, budget/job attribution, retries, cancellation, transcript restoration, and terminal envelopes. [STH-31](https://linear.app/platinum-labs/issue/STH-31/build-a-cross-provider-scientific-writing-quality-benchmark-and) and [STH-28](https://linear.app/platinum-labs/issue/STH-28/build-ci-qualitysecurity-gates-for-backend-webapp-migrations-tenancy) may proceed in parallel and are no longer blocked by this issue.

## Goal

Before replacing the Claude runtime, lock down the application-level behavior that callers depend on. These tests become the acceptance contract for every runtime/provider implementation.

## Scope

Create a provider-neutral test harness around `runAgentTask(...)` (or the new internal seam introduced by the architecture ADR) with a deterministic scripted/fake model provider. Avoid live-provider dependencies for the core suite.

The suite must cover:

* `text_delta` streaming followed by final `text`;
* tool call → tool result round-trips;
* tool grants by role and compose-mode denial of mutating tools;
* project storage containment and pending-edit/suggestion behavior;
* citation/comment/project-config event forwarding where applicable;
* `ask_user` question, reply, disconnect/detach, reconnect, expiry/teardown;
* nested `dispatch_agent` behavior, parent/child job attribution, shared budget, max depth;
* cancellation/abort and browser disconnect behavior;
* transient provider failure → normalized retry/notice/error semantics;
* budget cutoff;
* conversation logging and job status transitions;
* continuation/resume behavior without asserting a Claude-specific session implementation;
* usage accounting input/output fields;
* terminal `done` and `error` event shape.

## Design requirement

Tests must assert Kuhn's own public/internal contracts, not the exact message objects emitted by the Claude SDK. Existing Claude-specific tests may remain temporarily as adapter tests but cannot be the only protection.

## Acceptance criteria

* The suite runs without any model-provider credentials or network access.
* A deliberately incomplete runtime adapter fails the relevant contract tests.
* Existing Claude-backed behavior still passes during the transition.
* Subsequent runtime implementations can run the same suite unchanged.
* The project's provider-migration definition of done references this suite as a required gate.

### STH-7 — Introduce Kuhn AgentRuntime interface and normalized provider envelopes

**Status:** In Review · **Priority:** High · **Labels:** AI Runtime & Models, Next Up · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider>

## Ready for parallel scaffolding — 2026-08-30

The runtime ADR is complete. This issue may begin immediately by defining/documenting the seam, normalized envelopes, adapter test harness, and new provider-package modules. The production `runtime.js` cutover portion must integrate after [STH-1](https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers)'s neutral tool-registry handoff rather than independently reworking the same code. The transitional Claude adapter is required only as a parity oracle and rollback path during migration.

## Goal

Create the narrow internal seam beneath `runAgentTask(...)` that all provider/runtime implementations must satisfy.

## Contract should cover

* start/continue a model turn from Kuhn messages/context;
* streamed text/reasoning deltas where available;
* normalized tool-call requests and tool-result submission;
* abort/cancel;
* provider/model identity and capability metadata;
* normalized usage (input/output/cache/reasoning where exposed) without assuming one provider's fields;
* normalized finish/error taxonomy: auth, invalid request, rate limit, overload, timeout/network, context overflow, safety refusal, tool error, cancelled, unknown;
* serializable continuation state owned or wrapped by Kuhn rather than exposed SDK session IDs;
* provider retry hints (`retryAfter`, retryable) but no provider-specific HTTP parsing in product code.

## Architecture rule

`runAgentTask(...)` remains the application boundary and continues to own jobs, conversations, budgets, dispatch depth, questions, project events, and product-level retries. Runtime adapters own only the model/tool loop mechanics needed to satisfy this interface.

## Acceptance criteria

* Interface/types are documented and tested.
* Existing Claude implementation is temporarily adapted behind the interface and passes the contract suite.
* Routes/UI/job code outside the provider package has no Claude SDK imports/types.
* Provider-specific error/message parsing is isolated behind adapters.
* The interface does not expose Anthropic/Claude concepts by name.

### STH-8 — Implement Pi-core runtime adapter behind AgentRuntime

**Status:** In Review · **Priority:** High · **Labels:** AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-8/implement-pi-core-runtime-adapter-behind-agentruntime>

## Goal

Implement the first non-Claude Kuhn runtime using the lower-level Pi agent/model packages selected by the runtime-foundation ADR.

## Requirements

* Use the chosen Pi core/multi-provider packages, not the Pi coding-agent product/filesystem layer.
* Feed Kuhn-owned system prompts, conversation messages, role tools, and abort signals into the adapter.
* Translate Pi streaming/tool lifecycle into the normalized `AgentRuntime` envelopes.
* Do not load user/home-directory Pi context files, skills, extensions, or auth state implicitly in server mode.
* No direct filesystem/shell tools from Pi; only the neutral Kuhn tool registry is available.
* Support deterministic/fake-provider tests without network credentials.
* Make concurrency/session objects request-scoped; no accidental shared mutable model state between tenants.

## Acceptance criteria

* Pi adapter passes the same runtime contract suite as the transitional Claude adapter.
* A real non-Anthropic provider can complete a basic chat + tool-call + follow-up flow.
* Cancellation terminates model/tool work promptly.
* Provider/model identity and usage are surfaced through the normalized envelopes.
* Server startup and the full unit suite work with `ANTHROPIC_API_KEY` unset.

### STH-16 — Block stored active-content attacks from uploaded HTML/SVG and raw project files

**Status:** In Review · **Priority:** Urgent · **Labels:** Bug, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-16/block-stored-active-content-attacks-from-uploaded-htmlsvg-and-raw>

## Risk

`GET /api/projects/:projectId/file` serves files from the authenticated Kuhn origin and maps `.html` to `text/html` and `.svg` to `image/svg+xml`. Project upload accepts arbitrary types. An editor-controlled active document opened by another member can therefore execute browser content in Kuhn's origin and make authenticated same-origin requests even though the session cookie is HttpOnly.

Treat this as an active-content isolation problem, not only a MIME-validation problem.

## Remediation options to evaluate

* default raw/download endpoint to `Content-Disposition: attachment` for unsafe types;
* set `X-Content-Type-Options: nosniff`;
* never inline user-authored HTML/SVG on the primary authenticated app origin;
* if inline preview is required, serve it from a separate uncredentialed sandbox origin with a restrictive CSP/sandbox policy;
* sanitize or rasterize SVG where an image preview is required;
* define an explicit safe-inline allowlist instead of deriving trust from filename extension.

Audit reviewer/project/org-library download routes for the same class of issue.

## Acceptance criteria

* A malicious uploaded HTML/SVG fixture cannot execute script with access to authenticated Kuhn APIs.
* Browser/security tests cover direct navigation, `<img>/<object>/<iframe>` style embedding where relevant, misleading MIME types, and `nosniff`.
* Safe text/PDF/image workflows remain usable.
* Security behavior is documented in the threat model and data pipeline.
* No route serves untrusted active content inline on the credentialed application origin without an explicit sandbox boundary.

### STH-28 — Build CI quality/security gates for backend, webapp, migrations, tenancy, and provider contracts

**Status:** In Review · **Priority:** High · **Labels:** Security & Tenancy, Quality & Validation, Operations & Release · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-28/build-ci-qualitysecurity-gates-for-backend-webapp-migrations-tenancy>

## Ready now — 2026-08-30

The repository currently has no public-tree GitHub Actions workflow, so this can and should proceed independently of runtime implementation. Establish deterministic backend, webapp, tenancy, migration, and provider-contract gates first; add live-provider tests only as a separate protected/manual lane with explicit spend and secret controls.

## Goal

Turn the existing tests/check scripts into mandatory, reproducible merge gates. The current repository has substantial testing material but no public-tree CI workflow enforcing it.

## CI matrix

Run on pull requests and protected-branch changes as appropriate:

* dependency install from lockfiles on supported Node LTS;
* backend unit/integration tests;
* webapp build and deterministic browser/check scripts that do not require model spend;
* provider-neutral runtime contract suite using fake/scripted providers;
* tenancy/RBAC matrix;
* database migration fresh-install + supported-upgrade fixtures;
* lint/type/static checks adopted by the codebase;
* sandbox argument/security tests that do not require privileged Docker where possible;
* production configuration validation tests;
* packaging/container build smoke test once the deployment artifact exists.

## Security/supply-chain gates

* dependency vulnerability scan with an explicit severity/exception policy;
* secret scanning;
* license/dependency inventory appropriate to the MIT project;
* container/image vulnerability scan once images are produced;
* SBOM generation for release artifacts;
* optional static security tooling only where signal is high enough not to become ignored noise.

Live provider E2E tests should be a separate protected/manual/nightly lane with scoped credentials and spend caps; do not make every PR consume model quota.

## Acceptance criteria

* A PR cannot be considered merge-ready if the required deterministic gates fail.
* CI never exposes provider/session secrets in logs or forked/untrusted PR contexts.
* Cache usage cannot make stale generated artifacts appear to pass.
* Test failures link cleanly to actionable logs/artifacts.
* Required branch-protection/check names are documented for repository admins.

### STH-31 — Build a cross-provider scientific-writing quality benchmark and preserve Kuhn's current baseline

**Status:** In Progress · **Priority:** High · **Labels:** Quality & Validation, AI Runtime & Models · **Milestone:** Modernization 5 — Pilot & Acceptance · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-31/build-a-cross-provider-scientific-writing-quality-benchmark-and>

## Ready now — baseline capture must precede cutover

This work is intentionally unblocked and should run alongside the implementation tracks. Capture the current Claude-backed baseline from a fixed `main` SHA before adapter refactors alter prompt construction, tool transcripts, continuation, or retry behavior. The benchmark is now a hard blocker for [STH-14](https://linear.app/platinum-labs/issue/STH-14/remove-claude-agent-sdk-and-anthropic-required-configuration): functional parity alone is insufficient for the Pi cutover.

## Why

A provider migration can be functionally correct and still make Kuhn meaningfully worse at writing, research, review, or project orchestration. Capture the current quality bar before removing the Claude path and make provider/model selection evidence-driven by role.

## Benchmark corpus

Create versioned, non-sensitive evaluation projects using public/synthetic materials across representative Kuhn workflows, for example:

* grant proposal planning/drafting;
* manuscript section drafting/revision;
* RWE/RCT protocol structure and consistency;
* SOP/technical document editing;
* research/citation retrieval with known answer/reference sets;
* reviewer critique and comment triage;
* advisor guidance grounded in an org knowledge fixture;
* PM intake/project configuration and seeding;
* sub-agent orchestration where useful.

Capture a baseline from the current working Anthropic/Claude implementation **before the SDK-removal cutover removes it**, using fixed prompts/fixtures and recorded model/version metadata.

## Evaluation dimensions

Use task-specific deterministic checks wherever possible, plus structured human review for subjective writing quality. Evaluate at minimum:

* factual/source grounding and citation correctness;
* instruction adherence and completeness;
* preservation of source meaning and unsupported-claim rate;
* technical/scientific writing quality and organization;
* usefulness/specificity of review/advice;
* correct tool choice and side-effect discipline;
* successful file/comment/suggestion outcomes;
* latency/token/cost characteristics as secondary dimensions.

If model-based graders are used, do not make one provider's model the sole arbiter. Calibrate graders against human judgments and retain raw rubric scores.

## Routing outcome

The goal is not to crown one universal model. Produce a recommended role→profile matrix and acceptable fallback profiles. The RA may optimize differently from Writer/PM/Reviewer.

## Acceptance criteria

* Baseline results from the pre-migration implementation are retained with reproducible fixtures/configuration.
* At least the provider paths required by the live multi-provider matrix work are evaluated on the same corpus.
* Each role has explicit quality thresholds/regression limits for the pilot.
* Provider/runtime cutover cannot be called complete if functional parity is achieved but material quality regressions remain unexplained/unaccepted.
* Benchmark can be re-run for future model/provider upgrades without using private customer data.

### STH-47 — Ship an opt-in end-to-end Pi runtime preview with explicit rollback

**Status:** In Review · **Priority:** High · **Labels:** Next Up, Quality & Validation, AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-47/ship-an-opt-in-end-to-end-pi-runtime-preview-with-explicit-rollback>

## Goal

Turn the isolated Pi spike into a working, user-testable Kuhn path before the irreversible Claude SDK removal. This issue owns cross-track integration; it must not reimplement the tool registry, runtime seam, profiles, continuation, research, or accounting owned elsewhere.

## Current baseline — 2026-08-30

`main` is `382f4a0bcd420d35752d5c07f749360c8cccb983`. PR #69 established the provider-neutral contract and isolated Pi spike, but production `runAgentTask(...)` still uses the Claude Agent SDK. There are no open GitHub pull requests.

## Preview behavior

* Add an explicit deployment/operator runtime selection with safe defaults and a documented rollback path. During preview, Claude remains available only as the reference/fallback adapter; Pi must be selectable without source edits.
* Route the normal REST/WebSocket/job/session surfaces through the same `runAgentTask(...)` application boundary. Do not create a parallel product path or Pi-specific UI protocol.
* The selected Pi path must consume Kuhn-owned prompts, neutral tools, profile/capability resolution, canonical continuation, research tools, usage accounting, abort signals, and product-level retry/job policy.
* A Pi run must start and the server must boot with `ANTHROPIC_API_KEY` unset.
* Persist effective runtime/provider/model/profile identity so a continuation or retry cannot silently switch mechanics. Define an explicit migration/fallback rule when the original adapter is unavailable.
* No Pi coding-agent filesystem/shell tools, home-directory context, extensions, packages, skills, or implicit auth state may load in server mode.

## Required testable slice

Exercise at least:

 1. ordinary streamed chat;
 2. project read tool;
 3. proposed/safe draft edit through existing pending-edit semantics;
 4. citation or scholarly-research flow;
 5. general portable research flow;
 6. `ask_user` suspension/reply;
 7. sub-agent dispatch with parent/child attribution and shared budget;
 8. cancellation and client disconnect;
 9. follow-up conversation reconstructed from canonical continuation;
10. one configured non-Anthropic provider and one configurable OpenAI-compatible endpoint.

Cover all six roles at least with a basic prompt/tool-grant smoke; use deeper scenarios for the roles that exercise each capability.

## Collaboration and integration rules

* Treat this as the integration branch/PR, not a license to edit files claimed by active prerequisite issues.
* Consume versioned interfaces and handoff notes from [STH-1](https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers), [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider), [STH-8](https://linear.app/platinum-labs/issue/STH-8/implement-pi-core-runtime-adapter-behind-agentruntime), [STH-9](https://linear.app/platinum-labs/issue/STH-9/add-providermodelendpoint-profiles-with-capability-aware-per-role), [STH-10](https://linear.app/platinum-labs/issue/STH-10/make-conversation-continuation-and-retries-provider-portable), [STH-11](https://linear.app/platinum-labs/issue/STH-11/replace-claude-hosted-websearchwebfetch-with-kuhn-owned-research-tools), and [STH-13](https://linear.app/platinum-labs/issue/STH-13/normalize-token-context-cost-and-budget-accounting-across-providers).
* Resolve integration conflicts in this branch only after the owning issue branches are green and reviewed.
* Preserve human-readable rationale in commits, PR description, and Linear updates; do not assume agents or reviewers can infer intent from the diff.

## Acceptance criteria

* A documented switch selects Claude or Pi during the preview, with Pi exercised through the normal product surfaces and rollback verified.
* Deterministic end-to-end tests use a fake/scripted provider and require no credentials/network.
* A retained live smoke completes the required representative flows on a non-Anthropic provider without an Anthropic package path being invoked.
* The full existing backend/webapp test suite remains green.
* Runtime-specific imports and message/error parsing remain confined to adapters.
* Preview evidence and remaining parity gaps are recorded explicitly; unresolved gaps block [STH-12](https://linear.app/platinum-labs/issue/STH-12/support-custom-openai-compatible-endpoints-and-prove-a-live-multi) and [STH-14](https://linear.app/platinum-labs/issue/STH-14/remove-claude-agent-sdk-and-anthropic-required-configuration) rather than being waived silently.

### STH-55 — When the conversation is getting long

**Status:** In Review · **Priority:** Medium · **Assignee:** maintainer · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-55/when-the-conversation-is-getting-long>

This often happens at a key point, like after a long session of specing and planning. So when the user choses to "start fresh", theny should have the option (ON by default) to scan the recent convo history and summarize any clear action items so that the fresh agent can seemlessly pick up from there. E.g., if the PM says this just before a "start fresh": "Want me to have the Writer tweak length/tone, or should I resume the reference-fixing work now?" there is a clear hand-off that we must capture. So, we should read the last message and determine if that is the case, and if so, read back further to capture context and any hard-fought implementation guidance that might be there. If the last message is ambiguous, read a couple more to confirm.

### STH-58 — Slide themes: seeded defaults + org theme library

**Status:** In Review · **Priority:** Medium · **Assignee:** maintainer · **Parent:** STH-56 · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-58/slide-themes-seeded-defaults-org-theme-library>

Phase 2 of the slides epic. Marp themes are CSS files: seed a small catalog of default themes and let orgs upload their own, selected via `theme:` front-matter. Model on the shared-script library (`catalog_scripts`/`org_scripts` + read-only extra mount pattern in `sandbox.js`).

### STH-61 — Slide-theme testing follow-ups: theme-list tool, editor front matter, editable PPTX

**Status:** In Review · **Priority:** High · **Assignee:** maintainer · **Parent:** STH-56 · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-61/slide-theme-testing-follow-ups-theme-list-tool-editor-front-matter>

From testing [STH-58](https://linear.app/platinum-labs/issue/STH-58/slide-themes-seeded-defaults-org-theme-library):

1. Agents (PM) are confused about theme names — add a `list_slide_themes` tool so agents can enumerate installed themes (catalog + org + marp built-ins).
2. The PDF preview doesn't use the Marp renderer for decks edited in the rich editor — the Milkdown round-trip destroys the leading YAML front matter (`---` fences become `***` / setext underlines), so `marp: true` disappears from the saved file.
3. Exported `.pptx` is not editable — use `--pptx-editable`, which needs LibreOffice (absent from the stock `marpteam/marp-cli` image).

## Todo

### STH-53 — PI review system

**Status:** Todo · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-53/pi-review-system>

The current system for getting PI review with explicit approve/deny decisions is not very user-friendly. Currently agent changes land (e.g., from the writer agent) and the user has to scroll to the top of the doc to see a message that there are changes pending review. Here's what the PM says:

> On the edits you can't see: they're there, but they're staged as a **pending accept/reject suggestion**, not written to the document yet. That's why they don't appear in the doc as you're reading it — per Kuhn's human-in-the-loop rule, an agent's edits to `draft/main.md` arrive as reviewable hunks and the file on disk keeps its previous text until you accept. To see them, switch the editor to the suggestion/review view (the diff), and you'll get the changes hunk by hunk to accept or reject.

I don't like this system for a few reasons: it's very easy to miss the "pending…" message, and when I click it the changes have to accepted/rejected in bulk, not sentence-by-sentence, or word-by-word for a really small diff. We should put these changes in the doc itself with red/green indicating the old text and the suggested new text and accept/reject buttons for each item. I thought we already had this? I remember seeing it before, so I think we have code to do this. It's possible that issue [STH-44](https://linear.app/platinum-labs/issue/STH-44/writer-edits-were-not-visible-as-approvable-diff) and PR 81 to address it changed the review process? Anyway, I'm not concerned about not writing pending review items to the doc, so if we need to do that to make this a smoother UX we should do it. E.g., the changes could be coded in the markdown so reopening a file with pending changes will render the decision point, and any agent review can easily see that a file has unapproved changes. (I think VS Code-based tools like Cursor do this well).

### STH-56 — Slides with Marp

**Status:** Todo · **Priority:** Medium · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-56/slides-with-marp>

To facilitate creataing slides, we should fully support Marp md extensions and orgs uploading / creating slide templates. E.g., a user can upload a slide deck (support pdf. and pptx?) and we read it and create Marp template based on it. (this is probably an epic.)

### STH-63 — Comment delete confirmation

**Status:** Todo · **Priority:** Low · **Created:** 2026-09-02  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-63/comment-delete-confirmation>

Deleting a comment should require confirmation because it's easy to accidentally hit delete.

### STH-64 — Figure should be beautiful

**Status:** Todo · **Priority:** High · **Created:** 2026-09-02  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-64/figure-should-be-beautiful>

We need serious figure-building guidance. (See figures in test project 02). 

1. We should use the pattern of doing most of our work in python, including all figure plotting. R can be called to do analyses, but it should just save data that python reads and turns into tables and/or figures.
2. There should be a Kuhn default figure style guide (import from ds-sciwriter)
3. Text in figures should be kept to a minimum. Figures should *never* include caption text (there should be a proper text-based caption below the figure), and generally should not have a title/label. The only exception is for a multi-panel figure where the different panels need to be identified. In this case, a simple 2-panel figure will generally not need labels, as the caption can simply refer to "left plot", "lower bar char", etc. More complex figures should have the panels labeled with simple titles like "A. Psychedelic Substance Use", with any more detail provided in the caption.
4. While we're at it, tables that contain facts (e.g., numbers form an analysis) must be rendered deterministically. And like figures, the caption should be separate. Unlike figures, it should always be *above* the table. (Tables read top-to-bottom, figures read bottom (x-axis) to top.)

### STH-65 — Token limit behavior

**Status:** Todo · **Priority:** High · **Created:** 2026-09-02  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-65/token-limit-behavior>

I hit a token limit that paused PM and analyst work. It put up messages that were generally helpful, but it wasn't clear when I could resume. Then after a page refresh, these messages disappeared and it was unclear how to resume. I just told the PM to "resume", and it seemed to not have a good understanding of what work was paused by the limit and just did a standard project review. Not sure, but it seems like some of the mid-stream work that was paused was lost. Before pausing due to a token limit, we should draft a concise hand-off that can be used in these cases. 

## Backlog

### STH-12 — Support custom OpenAI-compatible endpoints and prove a live multi-provider matrix

**Status:** Backlog · **Priority:** High · **Labels:** Quality & Validation, AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-12/support-custom-openai-compatible-endpoints-and-prove-a-live-multi>

## Goal

Prove that provider agnosticism is real, not just an interface around one vendor.

## Required provider paths

Validate at least:

1. one direct non-Anthropic commercial/provider API;
2. a second materially different provider path;
3. a configurable OpenAI-compatible base URL representing self-hosted/local serving (e.g. vLLM/LM Studio-compatible protocol).

The exact models may change; tests should bind to capability profiles rather than hard-coded product marketing names wherever possible.

## Work

* Add endpoint/base-URL configuration with safe URL validation and no secret leakage.
* Support custom model metadata/capabilities for endpoints that cannot be auto-discovered reliably.
* Define health/credential validation that does not send project content.
* Run real end-to-end flows: normal chat, project read tool, proposed draft edit, sub-agent dispatch, citation/research path, question/reply, cancellation, follow-up conversation.
* Capture provider/model/effective endpoint and normalized usage in job diagnostics.
* Document unsupported capability combinations and graceful degradation.

## Acceptance criteria

* The same Kuhn codebase passes the retained E2E scenario suite on the required provider paths with configuration only.
* Custom endpoint can be switched without source edits.
* No Anthropic credential/package path is needed for these tests.
* A model without a required capability is rejected before task execution, not after partial side effects.
* Test evidence is retained and referenced from the issue before closing.

### STH-14 — Remove Claude Agent SDK and Anthropic-required configuration

**Status:** Backlog · **Priority:** High · **Labels:** AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-14/remove-claude-agent-sdk-and-anthropic-required-configuration>

## Goal

Complete the provider-independence cutover only after the portable runtime path has proven feature parity.

## Work

* Remove `@anthropic-ai/claude-agent-sdk` from package manifests/locks.
* Delete the transitional Claude runtime adapter and SDK-specific message/event parsing.
* Remove required `ANTHROPIC_API_KEY` setup, Claude Code credential fallback, Claude-specific session IDs, built-in WebSearch/WebFetch wiring, and Claude-family cost weighting.
* Update seed data, model/profile migrations, `.env.example`, README, deployment/data-pipeline/architecture docs, tests, smoke scripts, and contributor guidance.
* Search the repository for `anthropic`, `claude`, `haiku`, `sonnet`, and `opus`; classify every remaining occurrence as optional-provider support, historical documentation, or an accidental dependency.
* Ensure production boot does not instantiate or validate any Anthropic path unless explicitly configured as an optional provider.

## Acceptance criteria

* Fresh install/build/test succeeds with no Anthropic package or credential.
* Provider contract suite and live matrix gate pass.
* All six agent roles, seeding, suggestions, comments, citations/research, sub-agent dispatch, questions, cancellation, transcript restore, and provider switching work on supported non-Anthropic profiles.
* Documentation describes providers generically; Anthropic, if supported, is one optional provider and not a privileged path.
* A repository-wide dependency scan shows no runtime dependency on the Anthropic SDK.

### STH-15 — Add owner/admin UI for provider credentials, model profiles, and per-role routing

**Status:** Backlog · **Priority:** High · **Labels:** Security & Tenancy, Product & UX, AI Runtime & Models, Feature · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-15/add-owneradmin-ui-for-provider-credentials-model-profiles-and-per-role>

## Goal

Make provider independence operable by a real team without editing `.env`, SQL rows, or source code.

## Product surface

Add an owner/admin configuration surface consistent with Kuhn's existing organization administration UX.

Owners should be able to:

* see available deployment-managed provider/model profiles;
* add a permitted custom provider/OpenAI-compatible endpoint when policy allows;
* enter or replace organization-scoped BYOK credentials through a write-only secret flow when enabled;
* define model profiles and review detected/configured capabilities, context limits, pricing/accounting status, and endpoint identity;
* assign model profiles independently to PM, Writer, RA, Advisor, Reviewer, and Analyst;
* test connectivity/auth/capabilities without sending project content;
* see clear validation before saving a route that cannot satisfy a role's required tools/capabilities;
* revert to deployment defaults;
* see safe audit/history metadata for changes without secret values.

## Authorization

Provider/credential/routing administration is owner-only by default. Viewer/editor users may see the effective model/provider in task diagnostics only to the extent product policy permits; they must never receive credential material.

## Safety/UX

* Show hostname/provider/model clearly so an owner understands where organization content may be sent.
* Warn when selecting a third-party/self-hosted endpoint changes the data-egress boundary.
* Never echo a stored API key after save.
* Endpoint tests use a synthetic minimal request, not manuscript/org-library content.
* UI must distinguish deployment-managed profiles from org-owned profiles and disabled/revoked credentials.

## Acceptance criteria

* A fresh organization can be configured for a supported non-Anthropic provider entirely through the product/admin flow plus deployment prerequisites.
* Different agent roles can be routed to different profiles from the UI.
* Cross-role/provider validation prevents obviously incompatible assignments.
* Owner-only tenancy tests and secret-redaction tests pass.
* Changes generate the audit events defined by the tenancy/audit-trail work in this modernization program.
* No source edit/restart is required for ordinary role-routing changes unless the selected provider adapter itself requires a deployment change.

### STH-17 — Fail closed in production and validate security-critical configuration at boot

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-17/fail-closed-in-production-and-validate-security-critical-configuration>

## Problems confirmed in current boot path

* The server deliberately continues listening after DB initialization failure.
* `KUHN_AUTH_MODE` defaults to unauthenticated `dev`.
* Express `trust proxy` is enabled unconditionally.
* Several production requirements are documented but not enforced as one coherent production profile.

## Work

Introduce an explicit environment/profile distinction and centralized boot-time validation.

Production must refuse to start when required state is invalid, including as applicable:

* database/schema initialization failure;
* dev auth selected on a non-local production profile;
* missing/weak session secret;
* invalid public app URL / insecure cookie expectations;
* unconfigured trusted proxy policy;
* missing mail/IdP configuration when that auth path is enabled;
* invalid provider/model profiles or missing required secret references;
* unwritable persistence/backup prerequisites;
* unavailable sandbox worker/runtime when required;
* unsafe wildcard CORS or incompatible origins.

Add standard HTTP hardening appropriate to the chosen deployment: CSP/security headers, body/request limits at a global layer where needed, server header suppression, and safe error responses.

## Acceptance criteria

* `production` profile has no silent insecure defaults.
* DB/schema failure prevents readiness/listen or terminates immediately.
* Proxy trust is explicit and test-covered; spoofed forwarded headers cannot alter security decisions outside the trusted deployment boundary.
* Security headers are covered by integration tests.
* Dev remains easy to run locally without weakening production defaults.
* Deployment docs list every required production variable and how startup validates it.

### STH-18 — Add production identity adapter with OIDC/SSO and hardened session lifecycle

**Status:** Backlog · **Priority:** High · **Labels:** Feature, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-18/add-production-identity-adapter-with-oidcsso-and-hardened-session>

## Goal

Keep magic-link auth useful for small/self-hosted installs while adding an identity path suitable for a real organization and making session policy provider-independent.

## Direction

Introduce an auth-provider adapter at the existing session resolver boundary. Implement standards-based OIDC first so deployments can use Google Workspace, Microsoft Entra, Okta, Auth0, Keycloak, etc. without Kuhn storing passwords.

## Requirements

* OIDC authorization-code flow with PKCE/state/nonce validation as applicable.
* Explicit issuer/client/audience/redirect validation.
* Map verified identity to Kuhn user + org membership; signing in alone must never grant tenancy access.
* Preserve invitation-driven membership semantics unless an explicit domain/group provisioning policy is later added.
* Define session rotation, logout/revocation, idle/absolute TTL, invalidation on user/org changes, and multi-device behavior.
* Keep secure/httpOnly/SameSite cookie policy centralized and production validated.
* Record security-relevant auth events without logging tokens.
* Document break-glass/admin recovery.

SCIM/group sync may be a later follow-up unless the pilot team requires it; do not invent a directory-sync system inside this issue.

## Acceptance criteria

* A production deployment can use OIDC without enabling magic-link.
* Existing role/tenancy guards are unchanged and still authoritative.
* Tests cover forged state/nonce, expired session, revoked membership, suspended org, invitation-only access, and logout.
* No OAuth/OIDC tokens or client secrets appear in application logs.
* Magic-link remains an optional supported auth provider rather than hard-wired global behavior.

### STH-19 — Add rate limits, quotas, and abuse controls across public and expensive surfaces

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-19/add-rate-limits-quotas-and-abuse-controls-across-public-and-expensive>

## Goal

Protect authentication, guest review, uploads, rendering/ingestion, agent dispatch, and provider spend from accidental or hostile resource exhaustion.

## Scope

Define limits at the right dimensions: IP/anonymous token, user, organization, project, and deployment. Cover at minimum:

* magic-link/OIDC initiation and invitation verification;
* external review-link requests/comments;
* agent task starts, concurrent runs, nested dispatch, retry storms, token/cost budgets;
* uploads and org-library ingestion;
* render/export;
* SSE/WebSocket connection counts and reconnect storms;
* search/fetch tools and external scholarly APIs.

Use bounded queues/backpressure rather than only returning 429 after resources are already consumed. Provide owner/operator visibility into quota failures.

## Acceptance criteria

* Public auth/reviewer endpoints cannot be spammed without bounded application-level limits.
* Per-org concurrent/periodic agent limits are enforced before provider spend occurs.
* Limits return consistent retry information and do not leak tenant existence.
* Limits work correctly behind the configured trusted proxy boundary.
* Tests cover bypass attempts, concurrency races, and reset/retry behavior.
* Reasonable defaults and configuration are documented for the small-team production profile.

### STH-21 — Isolate and harden sandbox execution; remove web-process Docker root-equivalent exposure

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-21/isolate-and-harden-sandbox-execution-remove-web-process-docker-root>

## Context

The existing sandbox wrapper has good foundations: `--network none`, CPU/memory/PID limits, read-only project mount, bounded output, and timeout. However, the public Node process directly invokes Docker. Membership in the Docker control plane is effectively host-privileged, so compromise of the web process can collapse the sandbox boundary.

## Work

Follow the production-topology ADR and move sandbox execution behind an appropriately isolated boundary: dedicated worker/service, rootless container runtime, restricted socket/proxy, or equivalent design with a written threat model.

Also harden per-container defaults:

* pin images by immutable digest/version, not floating `:latest`;
* run as a non-root UID/GID where images permit;
* `no-new-privileges` and drop capabilities;
* read-only container root filesystem with explicit writable temp/output mounts where compatible;
* restrictive seccomp/AppArmor/SELinux profile where the deployment supports it;
* temporary-file limits and cleanup verification;
* image provenance/update/scanning policy.

Future analyst Python/R execution must use the same boundary and must not silently re-enable unrestricted network/package installation.

## Acceptance criteria

* Compromise of the internet-facing web process does not directly grant unrestricted Docker-daemon control in the production topology.
* Sandbox images are reproducibly pinned and updates are intentional.
* Existing render/export/ingestion tests pass under hardened constraints.
* Security tests cover network denial, read-only project mount, resource limits, timeout, output cap, and attempts to escape via paths/mounts.
* Deployment docs describe the sandbox trust boundary and operating prerequisites.

### STH-22 — Replace startup-time ad hoc DDL with versioned database migrations and upgrade safety

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Reliability & Data · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-22/replace-startup-time-ad-hoc-ddl-with-versioned-database-migrations-and>

## Problem

Database evolution currently mixes `schema.sql`, column-add lists, and hand-coded SQLite table rebuilds that execute at application startup. This has worked for rapid development but is hard to audit, test, roll forward/rollback, and recover safely with real team data.

## Work

* Introduce an explicit schema version/migration ledger.
* Convert existing schema changes into ordered, idempotent migration steps or establish a clean baseline plus forward migrations with documented compatibility.
* Separate schema migration from ordinary seed-data reconciliation.
* Define transaction/backup behavior for migrations that rebuild tables.
* Refuse to run against a schema newer than the application understands.
* Add preflight validation and clear operator errors for partial/failed migration state.
* Test migrations from representative historical schema snapshots, not only an empty database.
* Align with the production-topology ADR if Postgres is selected; do not build a SQLite-only migration abstraction immediately before replacing SQLite.

## Acceptance criteria

* Every schema change has an ordered migration id/version.
* Fresh install and upgrade-from-supported-old-version paths are automated tests.
* Failed migration cannot leave the service reporting ready against an ambiguous schema.
* Backup/restore/rollback instructions exist for destructive/rebuild migrations.
* Seed data remains idempotent but is no longer conflated with schema versioning.

### STH-23 — Implement data durability: backups, restore drills, retention, deletion, and export

**Status:** Backlog · **Priority:** High · **Labels:** Reliability & Data, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-23/implement-data-durability-backups-restore-drills-retention-deletion>

## Problem

Current docs explicitly state no built-in backups, no automatic retention, and indefinite chat transcript retention. Project git history protects file revisions but not the database or organization-library corpus.

## Work

* Define supported backup scope for database + project files + org-library originals + encryption/master-key dependencies.
* Implement a consistent backup mechanism appropriate to the chosen topology, with atomicity/consistency rules.
* Automate restore into an isolated validation environment and integrity-check tenant/project/reference/history relationships.
* Add configurable retention policy for conversations/jobs/tool results, audit records, deleted projects/users, and temporary artifacts.
* Define hard-delete semantics and any legal/operational grace period explicitly.
* Add organization/project export suitable for offboarding and disaster recovery.
* Document RPO/RTO targets for the pilot and ownership of backup monitoring.
* Ensure backup media is access-controlled/encrypted and does not leak provider secrets.

## Acceptance criteria

* A fresh staging instance can be rebuilt from a backup and pass an automated restore verification suite.
* A documented restore drill is performed and evidence retained before pilot.
* Retention settings are explicit and production defaults are defensible; chat is not silently 'forever' unless intentionally configured.
* Project/org deletion and export paths are test-covered.
* Backup failure is observable/alertable, not a cron job nobody knows stopped.

### STH-24 — Extend tenancy regression coverage and add a durable security/admin audit trail

**Status:** Backlog · **Priority:** High · **Labels:** Quality & Validation, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-24/extend-tenancy-regression-coverage-and-add-a-durable-securityadmin>

## Goal

Preserve one of Kuhn's strongest existing properties as new provider, auth, and worker surfaces are added: every tenancy decision must continue to flow through centralized authorization, with security-sensitive changes attributable after the fact.

## Work

### Tenancy matrix expansion

Extend the existing tenancy integration matrix to cover new and existing boundaries including:

* provider/model profile list/read/write/test;
* provider credential create/rotate/revoke/use;
* background job claim/cancel/retry/reconnect surfaces;
* OIDC identity paths and invitation flows;
* guest review links;
* org knowledge and curated-package selection;
* WebSocket/Yjs authorization and live membership changes;
* project/org delete/export/restore operations;
* platform super-admin behavior, verifying that platform privilege never becomes implicit tenant-content access.

Test principals across stranger/viewer/editor/owner/super-admin, active vs suspended org, removed/demoted membership, and cross-org object identifiers.

### Audit trail

Build on the existing auth-event work with a durable append-only audit surface for security/admin events, including at minimum:

* login/logout/session revocation and invitation lifecycle;
* membership/role changes and org suspend/unsuspend;
* provider profile/credential changes and credential tests;
* review-link mint/revoke;
* destructive project/org/library operations;
* production configuration or migration events that materially change access/data handling where feasible.

Record actor, tenant, action, target identifier, timestamp, outcome, and safe metadata. Do not log credentials, raw tokens, full prompts, document contents, or other unnecessary sensitive payloads.

## Acceptance criteria

* New production surfaces are represented in automated tenancy tests before pilot.
* Unknown/not-owned resources preserve the existing non-leaking behavior.
* Super-admin-without-membership remains unable to read tenant content.
* Audit records survive process restart and have a documented retention/export policy.
* Owners/operators can answer who changed a role/provider credential/review link and when without reading raw application logs.
* Redaction tests prove secret/token values are not written to the audit trail.

### STH-25 — Make agent jobs durable, leased, cancellable, resumable, and suspension-aware

**Status:** Backlog · **Priority:** Urgent · **Labels:** Operations & Release, Reliability & Data · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-25/make-agent-jobs-durable-leased-cancellable-resumable-and-suspension>

## Problem

Today live agent runs are process-memory objects. On restart, running job rows are marked `interrupted`; the user can redispatch, but the system does not own a durable execution lifecycle. Organization suspension also does not terminate a job already in flight.

For real team use, long-running agent work needs queue/worker semantics with deterministic recovery.

## Design goals

Follow the deployment-topology ADR and introduce a durable job lifecycle with explicit states such as queued, claimed/running, waiting_for_user, retry_wait, cancel_requested, cancelled, done, error, interrupted/dead-letter as appropriate.

## Requirements

* Atomic job claim/lease with worker identity, heartbeat, lease expiry, and bounded per-org/global concurrency.
* Graceful worker restart: expired leases are safely recoverable without two workers executing the same job.
* User cancellation persists and reaches the provider/tool runtime promptly.
* Org suspension, project deletion, membership removal/demotion when relevant, or credential revocation prevents further privileged tool execution and cancels/blocks affected work according to documented policy.
* Persist enough continuation state that jobs waiting on `ask_user` survive worker/web restart with a coherent reconnect path.
* Product-level retry policy is normalized by provider error class and respects retry-after/circuit-breaking; do not blindly repeat mutating tool calls.
* Parent/sub-agent jobs remain attributable and enforce shared cancellation/budget policy.
* Queue depth and stuck/dead-letter work are observable.

## Idempotency/safety

Define idempotency boundaries for all mutating tools before automatic replay. A lease expiry or provider retry must never duplicate a file move, accepted suggestion, comment, citation, org mutation, or other already-committed side effect.

## Acceptance criteria

* Kill the worker/process during representative chat, tool, sub-agent, and waiting-for-user jobs; after restart each job ends in a documented recoverable state with no duplicate side effects.
* Suspending an org terminates/prevents ongoing provider/tool work within a bounded time.
* Two workers cannot successfully own the same active lease.
* Explicit cancel survives process restart.
* Bounded queues/concurrency prevent one org from monopolizing workers.
* Integration tests retain evidence for crash, lease-expiry, cancellation, provider outage, and waiting-user recovery.

### STH-26 — Add structured observability: logs, metrics, traces, SLOs, and provider usage diagnostics

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-26/add-structured-observability-logs-metrics-traces-slos-and-provider>

## Goal

Make Kuhn operable without reading ad hoc console output or opening the database manually.

## Telemetry model

Introduce structured, correlated telemetry across HTTP, WebSocket/collaboration, jobs, provider calls, tool execution, rendering/ingestion, and persistence.

### Logs

* JSON/structured logs in production.
* Correlation identifiers for request, user (safe internal id), org, project, job, provider profile, worker, and trace where applicable.
* Explicit log levels and stable event names.
* Central redaction layer for session tokens, provider credentials, auth/OIDC tokens, review tokens, sensitive headers, and configured secret canaries.
* Avoid dumping prompts/document contents/tool payloads by default.

### Metrics

At minimum:

* request rates/errors/latency;
* active WebSockets/Yjs rooms/SSE subscribers;
* queue depth, job age, job duration/status, retries, cancellations, dead letters;
* provider latency/error class/rate limits/overload/circuit state;
* normalized tokens/cost by provider/model/org with access-appropriate aggregation;
* tool latency/error rates;
* render/ingest duration/failures;
* DB/persistence health and backup freshness.

### Tracing

Trace a user action through API → job → provider turn → tool calls/sub-agent → persistence where practical. Sampling/configuration must avoid exporting sensitive content.

### SLOs/alerts

Define pilot SLOs and actionable alerts for availability, agent completion/error rate, queue delay, provider failure, DB readiness, backup freshness, and sandbox worker health.

## Acceptance criteria

* An operator can diagnose a failed agent task using job/trace IDs without reading user document content.
* Provider-specific outages can be distinguished from Kuhn application errors.
* Canary-secret tests demonstrate redaction across logs/traces/errors.
* Dashboards/queries or documented examples exist for the pilot SLOs.
* Telemetry exporters are configurable/optional for self-hosted deployments; the app does not silently send operational data to a third party.

### STH-27 — Add readiness/liveness, graceful shutdown, connection draining, and dependency health

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Reliability & Data · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-27/add-readinessliveness-graceful-shutdown-connection-draining-and>

## Goal

Make process lifecycle safe for deploys, restarts, proxies, and supervisors.

## Work

* Separate liveness from readiness. Liveness should answer whether the process can be supervised; readiness must fail when Kuhn cannot safely serve requests because required persistence/schema/worker/sandbox dependencies are unavailable.
* Extend health diagnostics with safe dependency state for DB/schema, job worker/queue, sandbox executor, and required configured services. Do not probe model providers with user content.
* Implement graceful SIGTERM/SIGINT handling:
  * stop accepting new HTTP/agent work;
  * report not-ready;
  * drain or safely close SSE/WebSocket/Yjs connections with reconnectable semantics;
  * stop claiming new jobs;
  * allow bounded completion or return leases/continuation state safely;
  * flush telemetry/persistence;
  * exit within a configured deadline.
* Make startup ordering explicit so the service never becomes ready before schema/config/seeds/worker prerequisites are valid.
* Document reverse-proxy/supervisor timeouts and WebSocket forwarding requirements.

## Acceptance criteria

* Automated integration test sends SIGTERM under active HTTP, collaboration, SSE, and agent-job load and verifies no corrupt/ambiguous job state.
* Readiness goes false before shutdown/drain begins.
* A DB/schema dependency failure makes readiness fail and production boot behavior matches the fail-closed production configuration work.
* Health endpoints do not leak tenant/config/secret details.
* Deployment rollback/restart can rely on the lifecycle contract.

### STH-29 — Create reproducible production artifacts with automated upgrade and rollback

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-29/create-reproducible-production-artifacts-with-automated-upgrade-and>

## Goal

Replace the current operator workflow of `git pull && npm install && npm run build` with a versioned, reproducible release artifact and documented rollback path.

## Work

Implement the deployment artifact selected by the topology ADR, normally including a pinned Node runtime and built webapp/backend. Prefer immutable container/image artifacts for the server components unless the ADR justifies another packaging model.

Requirements:

* deterministic build from lockfiles and pinned runtime/tool versions;
* immutable version/commit metadata visible in health/operator diagnostics;
* pinned sandbox-image references and compatibility manifest;
* startup/migration preflight before declaring ready;
* explicit persistent volumes/storage that upgrades never overwrite;
* release manifest/SBOM and checksums/signing policy where practical;
* documented config/secret injection, TLS/reverse-proxy assumptions, and minimum host requirements;
* staging deployment workflow;
* automated or scripted upgrade from the previous supported release;
* rollback procedure that accounts for database migration compatibility, not merely swapping application code;
* release notes including schema/config/provider-profile changes.

## Acceptance criteria

* A clean host/staging environment can deploy Kuhn from a versioned artifact without cloning the repository or running development tooling.
* Repeating the same release build does not float major runtime/sandbox dependencies.
* Upgrade and rollback are exercised in staging with data preserved.
* Application version, schema version, and release commit are observable.
* Production docs contain a single supported deployment/upgrade path for the pilot, with alternatives clearly labeled non-reference/development paths.

### STH-30 — Run load, soak, and failure-injection tests across collaboration, agents, storage, and providers

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release, Quality & Validation, Collaboration, Reliability & Data · **Milestone:** Modernization 4 — Reliability & Operations · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-30/run-load-soak-and-failure-injection-tests-across-collaboration-agents>

## Goal

Establish the real operating envelope for the small-team production profile and find concurrency/recovery bugs before users do.

## Workloads

Build repeatable tests for realistic concurrent use rather than synthetic HTTP throughput alone:

* multiple editors in the same Yjs document plus autosave/history;
* users editing different projects/orgs concurrently;
* agent chat streams plus sub-agent dispatch and `ask_user` waits;
* simultaneous provider calls across mixed model profiles;
* uploads, org-library ingestion, render/export, citations/search;
* reviewer links/comments while members are editing;
* large-but-supported files/projects and long conversations;
* queue saturation and per-org fairness.

## Failure injection

Exercise:

* provider 429/5xx/timeout/connection reset and partial streams;
* worker crash/lease expiry;
* web-process restart/drain;
* DB/persistence interruption appropriate to the selected topology;
* sandbox timeout/crash/unavailable executor;
* backup job failure;
* client reconnect storms;
* org suspension or membership change during active collaboration/agent work.

## Measurements

Track latency percentiles, job queue delay/completion, error/retry rate, memory/CPU/file-descriptor growth, WebSocket stability, database contention, provider spend, and data consistency. Define the supported pilot concurrency envelope from evidence.

## Acceptance criteria

* At least one multi-hour soak run completes at/above expected pilot load with no unbounded memory/handle growth or data-consistency failure.
* Failure scenarios recover according to documented job/collaboration semantics without duplicate side effects.
* Per-org limits/fairness work under contention.
* Bottlenecks and hard scale ceilings are documented; any pilot-blocking finding becomes a Linear issue.
* Test scripts/results are reproducible and retained as release evidence.

### STH-32 — Write operator/admin runbooks for incidents, recovery, providers, and user lifecycle

**Status:** Backlog · **Priority:** High · **Labels:** Operations & Release · **Milestone:** Modernization 5 — Pilot & Acceptance · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-32/write-operatoradmin-runbooks-for-incidents-recovery-providers-and-user>

## Goal

A production system is not ready if only the person who wrote the code knows how to recover it. Write concise, executable runbooks for the small-team reference deployment.

## Required runbooks

At minimum cover:

* deploy a new release;
* migration preflight, failed migration, and rollback decision;
* restore from backup and validate integrity;
* provider outage/rate-limit/credential failure and switching/fallback policy;
* rotate/revoke provider credentials and OIDC/client secrets;
* queue backlog/stuck/dead-letter agent jobs;
* worker/sandbox outage;
* database/storage capacity or corruption warning;
* suspend/unsuspend an organization;
* remove/offboard a user and revoke sessions/review links;
* lost/broken admin access / break-glass recovery;
* suspected cross-tenant access or credential leak/security incident;
* backup failure/staleness;
* collaboration/WebSocket outage;
* model/profile upgrade and quality-regression rollback.

Each runbook should state symptoms/alerts, immediate containment, diagnostic steps, safe commands/UI actions, recovery, verification, and escalation/when not to proceed.

## Acceptance criteria

* Runbooks live in version control and reference actual production commands/endpoints/configuration.
* A second operator can execute backup restore, provider credential rotation, release rollback, and user offboarding in staging without tribal knowledge.
* Runbooks avoid copying secrets into shell history/logs where possible.
* Alert names and dashboards from the observability work point to the relevant runbook.
* Staging acceptance exercises the highest-risk runbooks before pilot.

### STH-33 — Pass the full staging production-acceptance gate

**Status:** Backlog · **Priority:** Urgent · **Labels:** Operations & Release, Quality & Validation, Security & Tenancy · **Milestone:** Modernization 5 — Pilot & Acceptance · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-33/pass-the-full-staging-production-acceptance-gate>

## Goal

Before inviting the real target team, prove the assembled system — not isolated issues — behaves like a production service in a staging environment that matches the reference deployment.

## Gate checklist

### Provider independence

* Boot and normal use require no Anthropic SDK or Anthropic credential.
* Required live provider matrix and custom OpenAI-compatible endpoint scenarios pass.
* Per-role routing/admin UI/credential rotation work end to end.
* Cross-provider quality benchmark meets the accepted thresholds.

### Security/tenancy

* Threat-model high/critical items are closed or formally accepted with an explicit rationale.
* Tenancy matrix passes across REST, WebSockets, background jobs, provider configuration, guest review, org knowledge, and administrative surfaces.
* Stored active-content/XSS fixture cannot reach authenticated APIs.
* OIDC/reference production auth, session lifecycle, rate limits, and audit trail pass.
* Secret-canary scans find no credential/token leakage in logs/traces/audit/errors/database fields outside intentional encrypted/secret storage.
* Sandbox isolation/security tests pass.

### Durability/recovery

Perform and retain evidence for:

* backup + clean restore into a new staging instance;
* application/schema upgrade from the previous supported release;
* rollback according to the documented compatibility rules;
* worker crash and lease recovery;
* provider outage/retry/fallback behavior;
* explicit job cancellation and org suspension during active work;
* graceful deploy/restart with active collaboration and agent work.

### Operations

* SLO dashboards/queries and alerts are live.
* Backup freshness and worker/provider failures trigger actionable alerts.
* A second operator executes representative runbooks.
* Load/soak/failure-injection results remain inside the declared pilot envelope.

### Product smoke

Using fresh non-production organizations/users, exercise project creation/seeding, editing/collaboration, citations, knowledge library, agent chat, suggestions, comments/review links, render/export, admin/roles, provider configuration, and deletion/export.

## Exit rule

Do not close this issue on 'looks good.' Attach or link retained evidence for every gate section. Any unresolved critical/high-confidence security, data-loss, cross-tenant, job-duplication, or material quality-regression finding blocks the pilot and gets its own issue.

## Acceptance criteria

* Every gate section above has retained staging evidence.
* Reference deployment can be recreated from documented artifacts/configuration.
* No known unaccepted production blocker remains.
* A written go/no-go note approves proceeding to a bounded real-team pilot.

### STH-34 — Run a bounded real-team pilot and make the production go/no-go decision

**Status:** Backlog · **Priority:** High · **Labels:** Quality & Validation, Product & UX, Collaboration · **Milestone:** Modernization 5 — Pilot & Acceptance · **Created:** 2026-08-14  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-34/run-a-bounded-real-team-pilot-and-make-the-production-gono-go-decision>

## Goal

Validate Kuhn with the real target team under controlled production conditions before declaring the Anthropic-exit + production-readiness scope complete.

## Pilot shape

Define a bounded cohort, duration, supported workflows, support owner, provider/model routing, data policy, and rollback/offboarding plan before inviting users. Start small enough that failures can be understood and recovered without putting mission-critical work at risk.

## During the pilot

Track both system and product outcomes:

* authentication/invitation/admin friction;
* editor/collaboration stability;
* agent task completion, retry/cancel behavior, queue delay, provider errors;
* quality feedback by role/workflow, especially Writer/RA/Reviewer/PM;
* citation/research trustworthiness;
* suggestion/review/comment ergonomics;
* render/export compatibility with actual downstream Word/PDF workflows;
* provider spend and latency by role;
* support incidents, confusing degraded states, and any manual operator intervention;
* backup/alert/runbook operation during normal use.

Do not collect private document content into analytics by default. Use operational metadata and explicit qualitative feedback; any content review for debugging/quality requires a clear consent/process appropriate to the team.

## Issue discipline

Every reproducible defect, security concern, data-loss risk, significant workflow blocker, or material quality regression discovered in the pilot gets a Linear issue with severity and evidence. Do not bury pilot findings in a closing comment.

## Exit criteria

A final go/no-go review must cover:

* all critical/high pilot findings resolved or explicitly accepted;
* quality thresholds still met on the selected production role→model routes;
* SLO/reliability behavior acceptable for the cohort;
* provider cost/latency acceptable;
* no unexplained tenant/security/audit anomalies;
* restore/rollback paths still current;
* operators/users have a documented support/escalation path;
* decision on expanding, holding, or rolling back adoption.

## Definition of done

Close only when the pilot has completed and a written production decision is attached. If the decision is 'hold' or 'no-go', the issue may still close as a completed pilot, but the project itself must remain incomplete until the blocking follow-up work is resolved.

### STH-59 — Agent slide authoring: de novo decks + manuscript→slides

**Status:** Backlog · **Priority:** Medium · **Parent:** STH-56 · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-59/agent-slide-authoring-de-novo-decks-manuscriptslides>

Phase 3 of the slides epic. Writer/PM prompt guidance and a slides guidance doc covering Marp syntax and deck structure, for both de novo decks and distilling a mature manuscript into slides. Mostly `db/prompts/*.md` + `guidance-docs/` + seed-data work once phases 1–2 exist.

### STH-60 — Template-from-deck: derive a Marp theme from an uploaded PDF/PPTX

**Status:** Backlog · **Priority:** Medium · **Parent:** STH-56 · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-60/template-from-deck-derive-a-marp-theme-from-an-uploaded-pdfpptx>

Phase 4 (capstone) of the slides epic. Ingest an uploaded slide deck — text via pandoc/poppler, page images via `pdftoppm` — and have an agent synthesize a Marp CSS theme matching its look. Depends on phases 1–2 and on project-workspace PDF reading ([STH-54](https://linear.app/platinum-labs/issue/STH-54/ra-cant-read-pdfs), PR #97).

### STH-62 — Sanitize org promotion Markdown previews to prevent stored XSS

**Status:** Backlog · **Priority:** Urgent · **Labels:** Security & Tenancy, Bug · **Created:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-62/sanitize-org-promotion-markdown-previews-to-prevent-stored-xss>

## Risk

The organization admin promotion preview renders project Markdown with `marked.parse(...)` and assigns the resulting HTML directly to `element.innerHTML` in `webapp/src/org-admin.ts`.

Project Markdown is user-controlled. A project editor can therefore place active HTML in a document (for example an image with an `onerror` handler), submit/promote that document for organization-library review, and cause script-capable markup to execute when an organization owner opens the promotion preview. This crosses a privilege boundary from project content author to org owner on Kuhn's credentialed application origin.

This is separate from [STH-16](https://linear.app/platinum-labs/issue/STH-16/block-stored-active-content-attacks-from-uploaded-htmlsvg-and-raw)'s raw-file serving bug: [STH-16](https://linear.app/platinum-labs/issue/STH-16/block-stored-active-content-attacks-from-uploaded-htmlsvg-and-raw) correctly makes raw HTML/SVG inert downloads, but this path explicitly parses Markdown and reinserts generated HTML into the app DOM.

## Confirmed sink

Current main (`91a63ef`), `webapp/src/org-admin.ts`, promotion preview:

```ts
const rendered = document.createElement('div');
rendered.className = 'admin-preview-md';
rendered.innerHTML = marked.parse(state.content ?? '', { async: false });
```

`marked` does not sanitize unsafe HTML.

## Work

* Treat promoted project Markdown as untrusted content.
* Remove the raw `marked.parse(...) -> innerHTML` trust boundary or sanitize the generated markup with a well-maintained sanitizer and a deliberately restrictive allowlist.
* Strip dangerous elements/attributes/protocols, including event-handler attributes, script-capable embedded content, unsafe URLs, and active SVG/HTML constructs.
* Prefer the same safe Markdown rendering policy anywhere Kuhn displays user-authored Markdown as HTML; audit for other `marked`/`innerHTML` combinations rather than fixing only one literal line.
* Preserve normal scientific Markdown preview features required for review.

## Acceptance criteria

* A malicious project document containing raw HTML/event handlers cannot execute when an org owner opens the promotion preview.
* Tests include at least event-handler payloads, script/iframe/object-style active markup, `javascript:` links, and ordinary Markdown formatting/links.
* A browser-level regression demonstrates no authenticated Kuhn API request can be triggered by previewed document content.
* No user-authored Markdown is inserted into the credentialed app DOM as unsanitized HTML.
* Any intentionally supported HTML subset is documented explicitly.

## Done

### STH-2 — Write production threat model and data-classification baseline

**Status:** Done · **Priority:** High · **Labels:** Quality & Validation, Security & Tenancy · **Milestone:** Modernization 1 — Architecture & Contracts · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-2/write-production-threat-model-and-data-classification-baseline>

## Completed — 2026-08-27

PR #71 merged as `1614e0790ae516465cecee3179fa03ec3bf6ccee`. `docs/security/threat-model.md` now records current and pilot trust boundaries, data classes, provider egress/credential risks, enforceable invariants, and a bidirectionally checked threat-to-remediation map. This issue establishes the governing baseline; downstream controls remain tracked separately.

## Why

Kuhn is intended to hold unpublished manuscripts, grant material, protocols, organization guidance, comments, full agent transcripts, and user identity data. Production hardening needs a written trust model rather than an ad hoc checklist.

## Work

Document:

* trust boundaries: browser, member API, guest-review API, WebSockets, agent runtime, background jobs, provider egress, scholarly APIs, SMTP/IdP, local storage/database, git history, sandbox runner, reverse proxy;
* principals: viewer/editor/owner, super-admin, external reviewer, agent role, background worker, deployment operator;
* data classes and sensitivity: drafts/uploads, org knowledge, prompts, transcripts/tool results, bibliography, auth/session tokens, provider credentials, audit events;
* egress paths and which data may be sent to each model/search provider;
* core threats: cross-tenant access, broken access control, stored XSS/active uploads, prompt/tool abuse, provider credential leakage, malicious documents, sandbox escape, Docker-host privilege, session theft, invitation abuse, resource exhaustion, provider outages, backup exposure, stale jobs after suspension/removal;
* production assumptions and explicitly unsupported deployment modes.

Use the existing `docs/data-pipeline.md`, tenancy matrix, storage/sandbox code, review-link surface, and auth flow as source material.

## Acceptance criteria

* Threat model is committed under `docs/security/` or equivalent and linked from the main architecture/deployment docs.
* Every high/critical threat has either an existing control with test evidence or a Linear remediation issue.
* Data classes have retention, encryption-at-rest expectation, backup expectation, and permitted egress documented.
* Provider configuration/credential handling is explicitly included; provider agnosticism must not create a new cross-tenant secret surface.

### STH-3 — ADR: define the production deployment topology and scale boundary

**Status:** Done · **Priority:** High · **Labels:** Operations & Release, Reliability & Data · **Milestone:** Modernization 1 — Architecture & Contracts · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-3/adr-define-the-production-deployment-topology-and-scale-boundary>

## Completed — 2026-08-27

PR #71 merged as `1614e0790ae516465cecee3179fa03ec3bf6ccee`. ADR 002 now defines the smallest defensible pilot topology, the web/worker event-control seam, sandbox-service boundary, SQLite scale ceiling, operation recovery model, backup/restore contract, readiness behavior, and explicit migration triggers. Follow-up implementation remains owned by milestones 3–4.

## Context

Today Kuhn is one Node process serving REST, static webapp, SSE, and Yjs WebSockets, with in-process SQLite, local files, in-memory live runs/pubsub, and direct Docker execution. That is simple and useful, but the production boundary must be explicit before reliability work fragments the architecture.

## Decision to make

Define the smallest production topology acceptable for the first real team pilot and the migration path to multi-instance scale.

Evaluate at least:

* keeping the web/API process single-instance for the pilot vs splitting a dedicated background worker immediately;
* SQLite/local files vs Postgres + object/file storage, with clear criteria for when migration is mandatory;
* where Yjs room state lives and what guarantees are required across restart/multi-instance deployment;
* how durable jobs are claimed/leased and how in-flight work survives worker failure;
* how sandbox execution is isolated from the public web process;
* reverse proxy/TLS/trusted proxy requirements;
* backup/restore ownership;
* deployment artifact and upgrade/rollback strategy.

## Principles

* Do not introduce distributed infrastructure merely for aesthetic 'production architecture'. The first target is a small real team.
* Conversely, do not call a topology production-safe if a web-process compromise grants host-root-equivalent Docker control or if backups/upgrades are undefined.
* Document explicit scale ceilings and triggers for the next architecture step.

## Acceptance criteria

* ADR committed and linked from `docs/deployment.md`.
* Pilot topology diagram includes persistence, worker/sandbox boundary, egress, reverse proxy, and backup path.
* Clear decisions are recorded for database, project/org file storage, background execution, and collaboration state.
* Follow-up issues in milestones 3–4 align with the ADR rather than making contradictory local choices.

### STH-4 — Restore missing knowledge catalog modules that break backend startup/tests

**Status:** Done · **Priority:** Urgent · **Labels:** Quality & Validation, Research & Knowledge, Bug · **Milestone:** Modernization 1 — Architecture & Contracts · **Created:** 2026-08-15 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-4/restore-missing-knowledge-catalog-modules-that-break-backend>

## Completed — 2026-08-18

PR #70 merged as `ee824d4586923983315f3dc136639974f089dfd4`. The missing knowledge-catalog database and route modules, the shipped catalog manifest, focused tenancy/ownership tests, and the token-free browser check are present on `main`; backend startup and the formerly failing suites were restored. The acceptance criteria below are satisfied.

## Evidence

Current `main` at `4ed5edf` imports two files that are absent from the repository:

* `agent-backend/src/db/seed.js` imports `./knowledge-catalog.js`
* `agent-backend/src/index.js` and `src/routes/tenancy-matrix.test.js` import `./routes/knowledge.js`

Missing files:

* `agent-backend/src/db/knowledge-catalog.js`
* `agent-backend/src/routes/knowledge.js`

`cd agent-backend && npm test` currently reports 50 passing test files / 680 passing tests, then fails `src/db/init.test.js` and `src/routes/tenancy-matrix.test.js` during import. Backend startup is also expected to fail at the same missing imports.

## Scope

Restore or implement the two modules expected by the knowledge-package phase-zero changes, including their intended tests and route/seed behavior. Do not weaken the tenancy matrix or skip the failing suites.

## Acceptance criteria

* backend startup imports successfully;
* `src/db/init.test.js` passes;
* `src/routes/tenancy-matrix.test.js` passes without skipping knowledge routes;
* full `agent-backend` test suite passes;
* knowledge catalog seed and route behavior remain tenant-safe.

### STH-6 — ADR + spike: choose Kuhn's provider-agnostic runtime foundation

**Status:** Done · **Priority:** High · **Labels:** AI Runtime & Models · **Milestone:** Modernization 1 — Architecture & Contracts · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-6/adr-spike-choose-kuhns-provider-agnostic-runtime-foundation>

## Completed — 2026-08-18

PR #69 merged as `9f365de828d9b9b97f77e181709add657fe1af10`. The ADR selects the maintained `@earendil-works/pi-agent-core` / `pi-ai` foundation, the isolated Pi spike and deterministic faux-provider tests prove the required primitives, and the capability/gap map is retained in the repository. Production remained on Claude by design; that implementation work is owned by [STH-1](https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers) and [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider) onward.

## Why

`agent-backend/src/agents/runtime.js` is currently a large Claude Agent SDK adapter, but it also owns substantial Kuhn product behavior. We need to select a runtime foundation without accidentally moving product semantics into another vendor/framework.

Pi's lower-level `pi-agent-core` + multi-provider `pi-ai` stack is the leading candidate because it separates the agent loop from provider/model access and supports custom/OpenAI-compatible endpoints. This is a hypothesis to validate, not a predetermined rewrite.

## Work

1. Inventory every Claude SDK behavior Kuhn currently relies on: streaming deltas, tool calls/results, interrupt/cancel, session resume, built-in web search/fetch, MCP wrappers, usage/cache accounting, error shapes, sub-agent dispatch, and human `ask_user` suspension.
2. Build an isolated spike using the candidate runtime foundation. Do not bulk-edit the production runtime yet.
3. Prove at minimum:
   * streamed text events;
   * Kuhn-defined custom tool invocation with schema validation;
   * cancellation/abort;
   * conversation continuation across turns;
   * one non-Anthropic provider;
   * one configurable OpenAI-compatible endpoint or deterministic fake provider;
   * usage metadata sufficient for Kuhn's accounting layer.
4. Compare Pi core against at least one credible alternative on the criteria that actually matter to Kuhn. The goal is not a generic framework bake-off; it is to identify the smallest dependency that lets Kuhn own its product semantics.
5. Write an ADR under `docs/` describing the decision, rejected alternatives, package/version pinning strategy, capability gaps, and escape hatch.
6. Update `docs/architecture.md` only after the spike supports the chosen decision.

## Guardrails

* Do not use Pi's built-in coding filesystem tools in production; Kuhn's `storage.js`, pending-edit semantics, citations, comments, org knowledge, and role grants must remain authoritative.
* Do not make hosted provider web-search a required runtime primitive.
* Do not assume provider session IDs are portable; that problem gets an explicit Kuhn-owned design.
* No Anthropic API key may be required to run the spike's non-Anthropic path.

## Acceptance criteria

* ADR is committed and clearly recommends a foundation or explicitly rejects the candidate after evidence.
* Spike has automated tests and can run without Anthropic credentials.
* A capability matrix maps current Kuhn behavior to the chosen runtime primitives and names every gap that subsequent issues must close.
* No user-visible Kuhn behavior is intentionally removed as part of this issue.

### STH-9 — Add provider/model/endpoint profiles with capability-aware per-role routing

**Status:** Done · **Priority:** High · **Labels:** AI Runtime & Models, Security & Tenancy · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-9/add-providermodelendpoint-profiles-with-capability-aware-per-role>

## Parallel implementation split — 2026-08-30

Phase A may begin now: add the profile/capability data model, validation services, seed migration, repository APIs, and tests without touching the active model loop. Phase B, wiring effective profiles into dispatch, remains blocked on [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider). Secret values are explicitly out of scope here; store credential references only.

## Goal

Replace Claude model-name strings and global `AGENT_MODEL` assumptions with structured provider/model profiles that can route each Kuhn role independently.

## Data model

A model profile should include at minimum:

* stable profile id/name;
* provider adapter/provider id;
* model id;
* endpoint/base URL when applicable;
* credential reference, never secret material in prompts/logs;
* context/output limits;
* capabilities such as tool calling, streaming, reasoning, vision, hosted search, prompt caching, structured output as needed;
* cost/accounting metadata or an explicit `unknown` state;
* optional provider-specific settings isolated in an adapter-owned JSON field.

## Routing

* Each agent role selects a model profile, replacing today's Claude-specific `agents.model` semantics.
* Support deployment defaults and safe organization-level override policy. Project-level overrides should be allowed only if the product requirement is explicit and authorization is clear.
* Validate capability compatibility before a run starts. Do not discover halfway through a task that a selected model cannot call tools.
* Surface the effective provider/model in job metadata and operator diagnostics.

## Security

Credential material is handled by the separate secrets issue; this issue stores references/identifiers only.

## Acceptance criteria

* PM/Writer/RA/Advisor/Reviewer/Analyst can intentionally use different model profiles without code changes.
* Invalid/missing/incompatible profiles fail before dispatch with a useful error.
* Existing seeded agent behavior is migrated without losing role defaults.
* No pricing logic relies on matching substrings like `haiku|sonnet|opus`.
* Tests cover mixed-provider role dispatch and capability rejection.

### STH-10 — Make conversation continuation and retries provider-portable

**Status:** Done · **Priority:** High · **Labels:** AI Runtime & Models, Reliability & Data · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-10/make-conversation-continuation-and-retries-provider-portable>

## Parallel implementation split — 2026-08-30

Phase A may begin now: define and persist canonical conversation/tool items, provider-native metadata invalidation rules, operation/idempotency ownership, and reconstruction tests in provider-neutral modules. Phase B, exercising provider switching and adapter restart/retry behavior, remains blocked on [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider) and [STH-8](https://linear.app/platinum-labs/issue/STH-8/implement-pi-core-runtime-adapter-behind-agentruntime). Do not make raw Pi or Claude message objects canonical state.

## Problem

Kuhn currently stores/resumes Claude SDK `session_id` values and relies on provider session semantics for reconnect/retry. A provider-agnostic system cannot assume a vendor can resume opaque server-side state.

## Direction

Make the canonical conversation state Kuhn-owned and serializable. Runtime adapters may optionally use provider-native continuation/cache handles as an optimization, but correctness must come from Kuhn's persisted message/tool history.

## Work

* Define canonical model conversation items for user/assistant text, tool calls, tool results, and any portable reasoning placeholders that are safe/necessary to persist.
* Define what is persisted vs ephemeral/redacted.
* On a new provider/model, reconstruct usable context from Kuhn state rather than requiring the original provider session.
* Keep detachable `ask_user` run behavior coherent: live process state may detach/reconnect, but a process restart should degrade to a well-defined resumable/retry path.
* Prevent duplicate tool side effects when retrying after a partially completed provider turn. Use idempotency/deduplication where necessary.
* Preserve provider-native cache/session handles only as adapter metadata with invalidation/fallback rules.

## Acceptance criteria

* A conversation can continue after switching between two supported provider/model profiles when capabilities allow.
* Restart/retry does not require an Anthropic/Claude session id.
* Retrying a partially failed turn does not silently repeat already-committed mutating tools.
* Contract tests cover reconstruction, provider switch, invalid provider-native handle, and process-restart fallback.
* UI transcript restore semantics remain unchanged or improve.

### STH-11 — Replace Claude-hosted WebSearch/WebFetch with Kuhn-owned research tools

**Status:** Done · **Priority:** High · **Labels:** AI Runtime & Models, Research & Knowledge, Feature · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-11/replace-claude-hosted-websearchwebfetch-with-kuhn-owned-research-tools>

## Parallel implementation split — 2026-08-30

The hardened search/fetch client, provenance envelope, egress policy, limits, and SSRF test suite may be implemented now as standalone Kuhn modules. Registering these tools into role grants and removing Claude-hosted WebSearch/WebFetch waits only on [STH-1](https://linear.app/platinum-labs/issue/STH-1/extract-kuhn-owned-tool-registry-from-claude-sdk-wrappers)'s neutral tool registry. PubMed/arXiv behavior must remain distinct and unchanged.

## Problem

RA/Advisor currently receive Claude SDK built-ins `WebSearch`/`WebFetch`. That makes an important domain capability provider-specific even if the core model loop becomes portable.

## Direction

Make general web research a Kuhn-owned tool surface. Provider-hosted search may later be used as an optional adapter optimization, but the product must have a portable baseline.

## Requirements

* Define explicit search/fetch tools with bounded inputs/outputs, timeouts, size limits, redirect limits, and egress policy.
* Preserve provenance: result URL/title/source metadata must be visible to the model and traceable in logs.
* Defend against SSRF and access to private/link-local/internal addresses.
* Restrict schemes and content sizes; reject credentials embedded in URLs.
* Decide whether the baseline search backend is a configured web-search API, a proxy/service, or another documented source. Provider choice must not be hard-coded into agent prompts.
* Keep PubMed/arXiv deterministic tools as separate preferred research paths where appropriate.
* Add usage/rate accounting and clear failure behavior.

## Acceptance criteria

* RA/Advisor can perform general research on a non-Anthropic model with no Claude hosted tools.
* Search/fetch work through the neutral tool registry and role grants.
* SSRF/egress security tests cover localhost, RFC1918/link-local, redirect-to-private, oversized response, and unsupported scheme.
* Source metadata is retained in tool logs/results.
* Removing Claude `WebSearch`/`WebFetch` does not remove a documented user capability.

### STH-13 — Normalize token, context, cost, and budget accounting across providers

**Status:** Done · **Priority:** High · **Labels:** Operations & Release, AI Runtime & Models · **Milestone:** Modernization 2 — Model & Runtime Independence · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-13/normalize-token-context-cost-and-budget-accounting-across-providers>

## Parallel implementation split — 2026-08-30

The normalized usage/cost schema, explicit unknown semantics, accounting service, job diagnostic projection, and provider-fixture tests may begin now in isolated modules. Runtime event ingestion waits on [STH-7](https://linear.app/platinum-labs/issue/STH-7/introduce-kuhn-agentruntime-interface-and-normalized-provider); profile pricing/capability metadata wiring waits on [STH-9](https://linear.app/platinum-labs/issue/STH-9/add-providermodelendpoint-profiles-with-capability-aware-per-role). Do not preserve Claude-family substring heuristics behind a generic function name.

## Problem

Current budget accounting is Claude-shaped: prompt-cache token fields are special-cased and model cost tiers are inferred from `haiku|sonnet|opus` substrings. That will become misleading as soon as roles use different providers/models.

## Work

* Define normalized usage fields: uncached input, cached input/read/write when known, output, reasoning where separately exposed, total/context estimate, provider-reported cost when available.
* Store provider/model/profile identity with job usage.
* Replace substring-based `modelCostWeight` with explicit profile/accounting metadata.
* Distinguish hard safety/resource limits from dollar-budget policy. Unknown pricing must remain `unknown`, never silently treated as zero.
* Ensure a shared parent/sub-agent budget is meaningful when child roles use different providers.
* Add context-window preflight/overflow handling where the adapter exposes limits.
* Make budget and usage data observable without exposing prompts or secrets.

## Acceptance criteria

* No Claude family-name matching remains in accounting.
* Mixed-provider parent/sub-agent runs enforce a documented shared-budget policy.
* Unknown/missing usage fields degrade explicitly.
* Job records/API diagnostics show effective provider, model profile, normalized usage, and budget result.
* Tests cover cached/uncached provider reports, missing cost metadata, and multi-provider dispatch trees.

### STH-20 — Add secure provider credential storage, scoping, rotation, and redaction

**Status:** Done · **Priority:** High · **Labels:** AI Runtime & Models, Security & Tenancy · **Milestone:** Modernization 3 — Security, Identity & Data · **Created:** 2026-08-14 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-20/add-secure-provider-credential-storage-scoping-rotation-and-redaction>

## Parallel implementation split — 2026-08-30

The threat-model prerequisite is complete. The write-only secret service, deployment-managed credential interface, redaction layer, canary tests, and rotation/revocation semantics may begin now. Profile-reference integration remains blocked on [STH-9](https://linear.app/platinum-labs/issue/STH-9/add-providermodelendpoint-profiles-with-capability-aware-per-role). Do not build the owner UI in this issue; [STH-15](https://linear.app/platinum-labs/issue/STH-15/add-owneradmin-ui-for-provider-credentials-model-profiles-and-per-role) consumes this boundary later.

## Goal

Provider agnosticism will introduce more credentials and possibly organization-specific endpoints. Build a secret boundary before model profiles become an admin feature.

## Requirements

* Separate model/profile metadata from secret material; profiles contain credential references only.
* Support deployment-managed credentials and, if org BYOK is enabled, org-scoped credentials that cannot be read by another tenant or returned to browsers after submission.
* Prefer an external secret manager/keyring integration where available; if encrypted application storage is supported, use envelope encryption with a deployment master key outside the database.
* Add create/replace/revoke/test flows with owner-only authorization and audit events.
* Redact API keys/tokens from logs, errors, traces, tool results, job records, and config dumps.
* Never send provider secrets into model prompts or tool-call arguments.
* Define rotation without downtime and behavior when a credential is revoked while jobs are running.

## Acceptance criteria

* No provider API secret is stored plaintext in ordinary DB/config rows intended for retrieval.
* Cross-org access tests cover create/test/use/rotate/revoke paths.
* Secrets are write-only from the browser perspective after creation.
* Logging/tracing tests use canary secret values and prove redaction.
* Provider adapters receive credentials only at the final execution boundary.
* Deployment docs explain secret-manager/master-key backup and rotation requirements.

### STH-35 — Remove new user self-registration

**Status:** Done · **Priority:** Urgent · **Labels:** Security & Tenancy · **Created:** 2026-08-21 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-35/remove-new-user-self-registration>

Because there is cost and risk associated with random users accessing the LLM agents and sandbox execution env, users must be invited. So rather than allowing users to self-register (and likely land in a confusing "no org" state), new users should end up in a "new user request" queue and the email they receive should indicate that rather than a magic link. Existing users just needing a new passkey should still get the magic link.

### STH-36 — Superadmin change orgs

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-23 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-36/superadmin-change-orgs>

When logged in as a superadmin, I can't see how to switch orgs. I can create new orgs and see the list of orgs under platform console, but can't switch orgs to browse and help manage them.

### STH-37 — Live external reviewer tags

**Status:** Done · **Priority:** No priority · **Assignee:** maintainer · **Created:** 2026-08-27 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-37/live-external-reviewer-tags>

When the user shares the doc witha external reviewer, the UI shows the user where the invited reviewer is in the doc. This is nice, however these live tags take up a whole line and are a bit too intrusive. We should make it more subtle, like a simple bar (|) with a semi-transparent little tag.

### STH-38 — /command help

**Status:** Done · **Priority:** No priority · **Assignee:** maintainer · **Created:** 2026-08-27 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-38/command-help>

The current UI shows a "/commands" in the top bar just to the right of the word count. This currently does nothing useful that I can see. But I think we can keep it (or something similar) that the user can click to get a list of all available /commands and what they do.

### STH-39 — Comment text isn't copyable

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-27 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-39/comment-text-isnt-copyable>

When a reviewer leaves a comment they often suggest alternative text. The current UI doesn't allow this text to be copied (tested on MacOS Chrome). The text can be highlighted (click-drag turns it blue), but as soon as the user stops click-dragging, the highlight disappears and a subsequent cmd-C fails to copy the text. 

### STH-40 — Clicking comment doesn't scroll

**Status:** Done · **Priority:** No priority · **Assignee:** maintainer · **Created:** 2026-08-27 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-40/clicking-comment-doesnt-scroll>

Clicking a comment highlights the text the comment referes to, but doesn't scroll to show the text, leaving the user to hunt for it themselves.

### STH-41 — Small writer edits modify whole sections

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-27 · **Completed:** 2026-08-27  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-41/small-writer-edits-modify-whole-sections>

When the write agent applies a small edit (e.g., changing a few words in one sentence), it rewrites the whole section, making it difficult for the user to confirm that it only changed what was asked and didn't drift other content. We should make this more fine-grained so the accept/reject edits show only senteces that have changed. We can try to get the writer to be more selective, and/or run a deterministic diff script that reduces the section-edits to just sentences that have changed. 

### STH-42 — citation markers should show context

**Status:** Done · **Priority:** High · **Created:** 2026-08-27 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-42/citation-markers-should-show-context>

When a user is reviewing a doc and sees a citation marker (the author,year chip) they have no way to confirm that it's an appropriate citation without digging into other docs or rendering the doc. We should show a summary of the reference in a hover box (author list, truncated to 5 or so, title, year, journal) and allow them dig deeper and see the full citation (with abstract). The latter may involve taking the user to the relevant part of the references.bib?

### STH-43 — agents have little context awareness

**Status:** Done · **Priority:** High · **Created:** 2026-08-28 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-43/agents-have-little-context-awareness>

E.g., I asked the PM to have the writer do a full-pass on "the doc" in an early-stage project where main.md is still empty, but we had writtena lit review and i was viewing / editing / commenting that doc. But the PM only looked at main.md and complained that it was empty. In this case, the PM should have known what doc I was viewing (and maybe even edit/comment history) and inferred that was what i was referring to. It should still confirm with a quick question if it is ambiguous (e.g., there are >1 non-empty docs).

### STH-44 — Writer edits were not visible as approvable diff

**Status:** Done · **Priority:** High · **Created:** 2026-08-28 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-44/writer-edits-were-not-visible-as-approvable-diff>

We should have a mechanism so that any agent edits on an existing file land as visible diffs that the PI can explicitly approve/reject. These should be sentence-level for large edits and word-level if the edits changed just a few words here and there.

### STH-45 — doc status bar gets crowded

**Status:** Done · **Priority:** High · **Created:** 2026-08-28 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-45/doc-status-bar-gets-crowded>

The status bar at the top of the live doc (e.g., "research / reviews / ai-scientific-writing-landscape.md 3,054 words  /commands  Share  History  Source  Comments (14)") gets crowded when both the chat and files panes are visible , and unusable if the comments are also shown (or on smaller screens). The main culprit is the full path/filename, which we don't need as it's shown in the main status bar at the top of the page. Also, the /commands are more top-level than doc-specific, so I think that can move up to the main status bar to leave the doc status bar, or maybe moved to a more generic "help" button that opens a pop-over.

### STH-46 — This conversation is getting long

**Status:** Done · **Priority:** High · **Created:** 2026-08-28 · **Completed:** 2026-08-30  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-46/this-conversation-is-getting-long>

I like this reminder to keep context relevant, but when I got this message and clicked the big prominant blue button to start a fresh conversation, it did that, show ing a little dim "resh conversation with PM — earlier chat context cleared" message but the big blue button is still there, likely leading some users to think it wasn't yet cleared. After the user clear the convo (either with the blue button or by clicking the alway-there refresh icon), this message should disappear.

### STH-50 — chat scroll

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-30 · **Completed:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-50/chat-scroll>

When the chat is generating output while the user is trying to read previous output above the scroll (a very common situation), it's impossible to read because the pane auto-scrolls to the bottom with every new word, even if the user is trying to hold the scroll in place to read earlier output. We should disable autoscroll once the user scrolls back in the history, maybe with a little indicator at the bottom that new content is below, that will re-enable auto-scroll and jump to the bottom if clicked. And, if the user scrolls all the way back down manually, we can re-enable auto-scroll.

### STH-51 — logging

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-30 · **Completed:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-51/logging>

We need proper, detailed logging in place. This is always important for debugging the product, but for Kuhn it is especially important for us to have a full audit-trail for how the output artifacts are generated.

On particular item that we should be sure to log: per-agent context window state. I'm a bit concerned that when the PM launches a sub-agent it doesn't start a fresh context but rather everything is staying in on big chat history.

### STH-52 — per-agent, current-context state indicator

**Status:** Done · **Priority:** Medium · **Assignee:** maintainer · **Created:** 2026-08-30 · **Completed:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-52/per-agent-current-context-state-indicator>

We should be able to see the context state of the current agent (e.g., the PM) that the user is talking with. Maybe a little indicator in the bottom of the chat window? 

### STH-54 — RA can't read pdfs

**Status:** Done · **Priority:** High · **Assignee:** maintainer · **Created:** 2026-08-31 · **Completed:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-54/ra-cant-read-pdfs>

The RA **couldn't machine-read either PDF** — the tools can't extract text from binary PDFs, so it fell back on web/media reports

### STH-57 — Marp core: render slide decks to PDF + PPTX/HTML export

**Status:** Done · **Priority:** Medium · **Assignee:** maintainer · **Parent:** STH-56 · **Created:** 2026-08-31 · **Completed:** 2026-08-31  
**Linear URL:** <https://linear.app/platinum-labs/issue/STH-57/marp-core-render-slide-decks-to-pdf-pptxhtml-export>

Phase 1 of the slides epic. Add a `marp-cli` Docker image to the sandbox roster (same invariants: no network, project mounted read-only, write-only /out). Route markdown with `marp: true` front-matter through Marp instead of the pandoc→Typst pipeline in `render.js`; PDF output drops into the existing iframe preview. Add `pptx` and `html` export formats alongside docx/tex for Marp documents.
