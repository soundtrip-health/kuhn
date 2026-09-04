# Spec: Model profiles and per-role routing (issues #107, #111, #112)

**Status:** implemented in stages — backend (PR #130), admin UI (#111, `webapp/src/org-models.ts`), multi-provider proof (#112)
**Issues:** [#107 — optimal agent models](https://github.com/soundtrip-health/kuhn/issues/107),
[#111 — admin UI for provider credentials, model profiles, and per-role routing](https://github.com/soundtrip-health/kuhn/issues/111),
[#112 — OpenAI-compatible endpoints and a live multi-provider matrix](https://github.com/soundtrip-health/kuhn/issues/112)
**Antecedents:** the provider-neutral runtime seam and factory (#96, `provider-runtime/`), the
org secrets store (#104, `db/org-secrets.js`), per-role model tiers (story 021, `agents.model`),
cost-weighted budgets (story 020, issue #110), and the threat model's provider policy
(`docs/security/threat-model.md` §4.2–4.3).

## 1. Goal

Let each agent run on the model that fits the task, across vendors an organization has
credentials for, without editing `.env`, SQL rows, or source — and keep the security
invariant the threat model states once: **provider egress is a property of an allowlisted,
tenant-scoped profile, never of anything the model can choose.**

### Non-goals

- Automatic difficulty estimation. The dispatcher (the PM/writer calling `dispatch_agent`, or
  the REST caller) states difficulty; absent, the task is treated as hardest.
- Replacing the deployment's Anthropic key. Deployment-managed profiles stay; org profiles
  add to them.
- Provider-hosted web search on non-Anthropic profiles (STH-11). The route UI warns; the agent
  runs without `web_search`.
- Model/profile *discovery* from providers. Metadata is declared on the profile.

## 2. Concepts

**Model profile** — one provider/model/endpoint with declared capabilities and a cost weight.

| Kind | Where | Slug | Credential |
|---|---|---|---|
| Deployment-managed | derived from config at read time (`deploymentProfiles()`): one Anthropic profile per distinct seeded `agents.model` (+ `AGENT_MODEL`), and the `KUHN_PI_*` preview when set | `deployment-<model-id>`, `deployment-pi-preview` | the deployment's env var (`ANTHROPIC_API_KEY`, `KUHN_PI_API_KEY_ENV`) |
| Org-owned | `model_profiles` rows | owner-chosen, `[a-z][a-z0-9-]*`, the `deployment-` prefix reserved | `credential_secret`: an `org_secrets` name; NULL only for `openai-compatible` (keyless local server) |

Providers: `anthropic` (Claude Agent SDK adapter, org key layered onto the SDK subprocess
env), `openai` (Responses API via pi-ai), `openrouter` (completions via pi-ai), and
`openai-compatible` (completions against `base_url`). Fixed-endpoint providers forbid a
`base_url`; the compatible provider requires one.

**Capabilities** (JSON, all optional): `reasoning`, `input` (`text`/`image`), `contextWindow`
(≥ 1024), `maxTokens`, `tools`. For catalogued OpenAI/OpenRouter ids the pi-ai catalog entry
wins; an uncatalogued id runs on the declared metadata (#112 "custom model metadata").

**Cost weight** — in the deployment's `AGENT_MODEL_WEIGHTS` units (Haiku 1, Sonnet 3, Opus 5):
feeds the per-task budget and the org spend ledger (`jobs.weighted_tokens`) in place of the
model-id substring match. Deployment profiles derive theirs from the weights table.

**Route** — per org and agent slug, a ranked list `[{ profile_slug, difficulty }]` where
`difficulty` (0..1) is the highest task difficulty that profile is trusted with. Empty list =
deployment default for that role, which is exactly the pre-#107 behavior (seeded
`agents.model` on the operator's key; the Pi preview when `KUHN_AGENT_RUNTIME=pi`).

## 3. Dispatch-time selection (`agents/model-routing.js`)

```
difficulty d = clamp(task.difficulty, 0, 1), default 1
routes      = agent_model_routes for (org, agent) sorted by difficulty asc
chosen      = first route with route.difficulty >= d, else the last (strongest)
profile     = chosen ? getProfile(org, chosen.profile_slug) : deploymentDefaultProfile(agent)
```

`runTask` resolves the route right after loading the project and **before** creating the
job. `requirementFailure(profile)` refuses a profile that cannot run an agent at all (disabled,
`tools: false`, no text input, secret name missing, or a route whose deployment profile
vanished) with an `error` event `reason: 'route_invalid'` and no job — never after partial
side effects (#112).

Difficulty sources: `dispatch_agent`'s optional `difficulty` argument (the tool description
tells the model how to grade a sub-task), the REST task body (`POST /api/agent/task`), or the
`runAgentTask` task object. The seeding pipeline and resume paths pass none (hardest).

The credential is resolved server-side at the moment the runtime is built
(`resolveCredential`): an org secret becomes `{ apiKey }`, a deployment profile `{ apiKeyEnv }`,
a keyless endpoint `{}`. The value is handed to the adapter constructor and dropped; it never
reaches the route object, the job row, a log line, or an event (tests assert this on the
runtime, both adapters, the probe, and the routes).

## 4. Runtime factory (`provider-runtime/factory.js`)

`createAgentRuntime({ profile, credential, … })` builds from the profile and ignores
`KUHN_AGENT_RUNTIME`; the legacy no-profile call still honours the selector (the conformance
harness and older tests use it). Per provider:

- `anthropic` → `createClaudeRuntime({ model: profile.model_id, apiKey })`; the SDK subprocess
  gets `{ ...process.env, ANTHROPIC_API_KEY: apiKey }` for that runtime only.
- `openai` / `openrouter` → the pi-ai provider built with `staticApiKeyAuth` when a value was
  resolved (else the named env var); an uncatalogued model id is added as a declared model.
- `openai-compatible` → `createOpenAICompatiblePiRuntime({ baseUrl, …capabilities })`.

Jobs are stamped with `profile` and `endpoint` beside `provider`/`model`, at start (so a
running job already shows its route) and at every terminal.

## 5. Owner HTTP surface (`routes/model-profiles.js`, owner-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/orgs/:orgId/model-profiles` | deployment (read-only) + org profiles; credential *names* only |
| POST | `/api/orgs/:orgId/model-profiles` | create; 400 `{ error, field }` |
| PATCH | `/api/orgs/:orgId/model-profiles/:slug` | update (slug immutable); 404 for deployment/unknown |
| DELETE | `/api/orgs/:orgId/model-profiles/:slug` | removes the profile and any routes naming it |
| POST | `/api/orgs/:orgId/model-profiles/:slug/test` | synthetic one-turn probe (`agents/model-probe.js`): no tools, no project content; returns identity, latency, usage, contract violations, scrubbed error |
| GET | `/api/orgs/:orgId/model-routes` | every agent: default profile, routes, advisory warnings |
| PUT | `/api/orgs/:orgId/model-routes/:agentSlug` | replace the list; returns warnings and `egress: { before, after, added }` hosts so the UI can flag a changed data boundary |

Writes are audited as `model_profile.saved` / `.deleted` / `.tested` and `model_route.saved`
with slugs, endpoints, and outcomes only.

### Base-URL policy (`validateBaseUrl`)

Absolute http(s); no credentials, query, or fragment; **https required for public hosts**;
loopback / link-local / RFC-1918 / `.local`/`.internal` hosts refused unless
`KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS=true` (default true only in dev auth mode). Plain `http:`
is accepted only for such private hosts. The adapter's own `validateEndpoint` remains as the
second line.

## 6. Storage

```sql
model_profiles (id, org_id, slug, name, provider, model_id, base_url, credential_secret,
                capabilities JSON, cost_weight, data_policy, enabled, created_by, timestamps,
                UNIQUE (org_id, slug))
agent_model_routes (org_id, agent_slug, profile_slug, difficulty, updated_by, updated_at,
                    PRIMARY KEY (org_id, agent_slug, profile_slug))
jobs.profile, jobs.endpoint   -- init.js COLUMN_MIGRATIONS
```

`data_policy` is an owner-facing note on the provider's data handling (logs/trains/retains) —
surfaced, not enforced (threat model §4.3).

## 7. Tests

- `db/model-profiles.test.js` — deployment derivation and tier weights, base-URL policy
  matrix, field-level validation, cross-org isolation, CRUD, route store.
- `agents/model-routing.test.js` — selection rule, difficulty normalization, requirement gate,
  resolution against the real store, credential resolution and the missing-secret failure.
- `agents/model-probe.test.js` — probe outcomes with the credential scrubbed, timeout.
- `routes/model-profiles.test.js` — owner gating, CRUD + 400 fields, deployment read-only,
  probe endpoint, route PUT with egress/warnings, other-org profile refusal, audit rows.
- `provider-runtime/factory.test.js`, `pi-adapter.test.js`, `claude-runtime.test.js` — the
  profile path per provider, static-key auth precedence and non-leakage, declared models, the
  SDK env layering.
- `agents/runtime.test.js` — job stamping, `route_invalid` refusal before any job, org
  credential reaching only the SDK env, cost-weight metering, difficulty threading through
  `dispatch_agent`.
- The conformance suite runs unchanged on both drivers through the deployment default.

## 8. Admin UI (#111, `webapp/src/org-models.ts`)

Owner-only **Models** tab in the org admin overlay: a provider-credential form that saves an
org secret under a suggested name; the profile table (deployment rows read-only) with Test /
Edit / Delete and an inline probe result; the profile form (slug immutable on edit, base URL
shown only for the compatible provider, credential picked from the org's secrets, declared
capabilities, cost weight, data-policy note) that states the destination host and credential
as it is edited; and per-agent routing rows (profile + difficulty ceiling) with Save / Discard /
Revert to default. Saving a route whose profiles add a destination host asks for confirmation
naming the host, and the server's `egress.added` is toasted after the save. Warnings from the
route API (web search unavailable off Anthropic) render under the agent. Browser check:
`npm run models-check` (Playwright, token-free).

## 9. Multi-provider proof (#112)

**Over the wire, token-free.** `conformance/conformance-http.test.js` runs the full
provider-neutral scenario suite (22 scenarios) on the **real** OpenAI-compatible Pi runtime
talking real HTTP to `conformance/fake-openai-server.js`, a scripted chat-completions server
(SSE role/content/tool-call deltas, finish reasons, the `include_usage` usage chunk, held
requests for cancellation, HTTP-rendered provider failures). The driver
(`conformance/drivers/pi-http.js`) points the deployment default at the server and builds the
runtime through the production factory's profile path; nothing between the product seam and
the socket is replaced. The suite passes and reports identical terminals, job statuses, and
usage to the Claude driver. OpenRouter shares pi-ai's completions client with this path, so the
wire handling is the same; the OpenAI Responses API path is exercised only live.

**Live, credential-gated.** `npm run smoke:provider-matrix` runs one bounded tool-using turn
through the factory's profile path on every provider that has a credential in the environment
(`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `KUHN_MATRIX_BASE_URL` + `KUHN_MATRIX_MODEL` for a
self-hosted server, `ANTHROPIC_API_KEY`), checks the normalized contract, the tool call, and the
final marker, and prints a JSON table; paths without credentials are reported as skipped, never
faked.

**Capability rejection before execution.** `requirementFailure` refuses a profile before a job
exists (§3); `route_invalid` is covered in `runtime.test.js`.

**Documented degradation.** Provider-hosted web search exists only on the Anthropic provider;
the route API and UI warn per profile. Image input is declared per profile and not used by
any agent today. Reasoning models get pi-ai's default effort when `capabilities.reasoning` is
set.

## 10. Follow-ups

- Difficulty guidance in the PM/writer prompts, once routing is in use (prompt change, needs a
  quality pass).
