# System Architecture

> **Status:** Active — revised 2026-08-14; fact-checked against `main` 2026-10-18 (code
> references are `agent-backend/src/` paths with line numbers as of commit `119fc10`). Markdown-first editor (Milkdown), transitional agent
> runtime on the Claude Agent SDK, and multi-tenancy invariants adopted. The provider-neutral
> execution direction is recorded in [ADR 001](adr/001-provider-agnostic-runtime-foundation.md).
> This supersedes the TeXlyre-based architecture finalized 2026-04-17 (historical Epic 001
> editor-foundation research; preserved in git history);
> see [Decision Revisions](#decision-revisions-2026-06-11) below.

## Overview

Kuhn is a web application for scientific and technical writing with integrated AI agents. One app,
three surfaces:

1. **Editor** — a browser-based WYSIWYG markdown editor (Milkdown) with citations, math,
   cross-references, and slash commands
2. **Agent chat** — conversational interface to the seven agents (PM interview, project seeding,
   review cycles). The seeded agent slugs are `pm`, `writer`, `ra` (Research Assistant),
   `advisor`, `reviewer`, `analyst` and `help` (feature-guide Q&A) — `db/seed-data.js:14-23`
3. **File manager** — project tree, uploads, previews

A Node.js backend hosts the agent runtime, project storage, rendering/export, and Yjs
collaboration servers.

For the operator's view — where data is persisted, how it is processed, and what leaves
the machine — see [data-pipeline.md](data-pipeline.md) (story 040). For the production
security model (trust boundaries, principals, data classification, threat inventory) see
the [threat model](security/threat-model.md), and for the intended production topology
and scale boundary see [ADR 002](adr/002-production-deployment-topology.md).

## Document Format Strategy

- **Canonical authoring format: markdown** (Pandoc/Quarto flavor) with BibTeX (`.bib`)
  bibliographies. This matches the agent pipeline, which has always been markdown-native
  (markdown handoffs, `draft/main.md`, citation keys).
- **Rendering: Typst** — markdown → Typst → PDF for live preview and final output. Templates
  handle journal/funder formatting so users never touch typesetting.
- **Export: Pandoc** — `.docx` (critical: FDA submissions and most collaborator workflows are
  Word), `.tex` (escape hatch for LaTeX-native collaborators and journal submission), HTML.
- **LaTeX is an export target, not an authoring surface.** Fine-grained formatting is the
  toolchain's job (and increasingly the agents'), not the user's.

What markdown alone can't express, the flavor supplies: `[@citekey]` citations, cross-references,
captioned figures/tables, math (LaTeX syntax inside `$...$`).

## High-Level Components

```
┌────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                      │
│                                                             │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Milkdown Editor │  │  Agent Chat  │  │ File Manager │   │
│  │  - WYSIWYG md    │  │  - PM/agents │  │ - tree/upload│   │
│  │  - /commands     │  │  - streaming │  │ - preview    │   │
│  │  - Yjs collab    │  │              │  │              │   │
│  └────────┬─────────┘  └──────┬───────┘  └──────┬───────┘   │
│           └───────────────────┼─────────────────┘           │
│                     WebSocket / REST                        │
└───────────────────────────────┼─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                      Backend (Node.js)                       │
│                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Agent       │ │ Storage API │ │ Render/  │ │ Yjs      │   │
│  │ Runtime     │ │ (project-   │ │ Export   │ │ signaling│   │
│  │ (Claude SDK │ │  root       │ │ (Typst,  │ │ + WS     │   │
│  │  or Pi)     │ │  enforced)  │ │  Pandoc) │ │          │   │
│  └──────┬──────┘ └─────────────┘ └──────────┘ └──────────┘   │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐    │
│  │ SQLite: prompts, conversations, jobs, projects,       │    │
│  │ references (all rows project/tenant-scoped)           │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
        project storage: per-project directories (git-trackable)
```

## Editor Foundation

**Decision (2026-06-11):** Build the editor on **Milkdown** (MIT) — a plugin-driven WYSIWYG
markdown editor framework on ProseMirror + remark, with a first-class Yjs binding.

**Refinement (Epic 004, 2026-06-13):** The hand-rolled Milkdown build was replaced with
**Milkdown Crepe** (the Notion-style distribution, on `CrepeBuilder`) — toolbar, block-edit
slash menu, block handle, image/table/code-mirror/latex features out of the box. Yjs collab and
Kuhn's custom surface (citation chips, `/cite`, `/write`, agent slash commands folded into one
menu) re-attach to `crepe.editor`. Crepe's slash menu is Notion-style: it opens only when a
block's text starts with `/` (the retired `slash.ts` matched mid-block) — an accepted change.

Why Milkdown:

- **Audience fit** — target users (protocol, grant, SOP authors) are Word/Docs people, not
  LaTeX people. Typora-style inline WYSIWYG markdown is the right surface; the agents are the
  product, the editor must not be a barrier.
- **Slash commands are native** to the ProseMirror ecosystem — better fit than the CodeMirror 6
  retrofit used for `/cite` in the TeXlyre fork.
- **Yjs binding** — we already run y-webrtc signaling and y-websocket servers; collaboration
  carries over.
- **MIT license** — dissolves the earlier AGPL open-core apparatus entirely (the
  superseded strategy document is preserved in git history). No public-fork obligation,
  no legally mandated app split.

Consequences:

- **Single app.** The "two separate apps" split (agent workspace vs. editor) existed for AGPL
  isolation. With an MIT editor stack, chat, editor, and file manager are one application.
- **TeXlyre fork removed.** The `/cite` backend logic (PubMed grounding, bib management,
  Epic 003) was ported; only the editor-side UI was rebuilt as a Milkdown/ProseMirror plugin.
  The port completed with story 002-016 and the fork (plus the unused `web-citation/`
  reference module) was deleted in story 002-023 (2026-06-12) — git history preserves both.

## Agent Runtime

**Original decision (2026-06-11):** Build agent execution on the **Claude Agent SDK** rather than
a custom router + provider-agnostic LLM interface. The SDK provides the agent loop, tool use,
subagent spawning, MCP, sessions, and streaming.

**Migration decision (2026-08-14):** Preserve the Claude implementation as the transitional
reference path while introducing a narrower provider-neutral execution seam underneath
`runAgentTask(...)`. [ADR 001](adr/001-provider-agnostic-runtime-foundation.md) selects Pi's
lower-level model/agent-core primitives for phased implementation after Kuhn-owned tool behavior
is frozen. Kuhn is not adopting Pi's coding-agent product or filesystem/shell environment.

**Lock-in hedge — abstract at the agent-task boundary, not the LLM-call boundary.** The backend's
internal contract is:

```
runAgentTask({
  role,        // agent slug: pm | writer | ra | advisor | reviewer | analyst | help
  projectId,   // project root the task may touch
  input,       // user message or dispatch instruction
  context,     // selection, cursor, file refs
}) → stream of events: { text_delta | text | file_change | citation | question |
                          question_expired | done | error }   (+ stage markers from pipelines)
```

Everything above this interface (routes, UI, job model, logging and product policy) is intended
to be provider-neutral. The normalized execution seam now exists: `agents/runtime.js`
(`runAgentTask`, `agents/runtime.js:118`) builds an `AgentRuntime` through
`createAgentRuntime(...)` (`agents/runtime.js:642`) and consumes the normalized event contract
(`agents/provider-runtime/contract.js`); it never names a provider adapter directly. Raw
chat-completion calls are not exposed to product code.

### Provider runtime adapters (Claude, Pi)

`agents/provider-runtime/factory.js` is the one place the provider choice is made
(`createAgentRuntime`, `factory.js:72`):

| Selector | Adapter | How it executes |
|---|---|---|
| `KUHN_AGENT_RUNTIME=claude` (default, production) | `claude-runtime.js` | Spawns the Claude Agent SDK's bundled Claude Code CLI as a **child process** per turn (`sdkQuery`, `claude-runtime.js:204-222`) with `cwd` = the project workspace, `permissionMode: 'bypassPermissions'`, `settingSources: []` (no host `CLAUDE.md`/settings), and `tools` restricted to the provider built-ins the role is granted (only `WebSearch`/`WebFetch`, via the `web_search` grant — `claude-tools.js:26`). Every Kuhn tool is exposed through one in-process MCP server (`mcp__kuhn__*`), so the agent has **no** shell, filesystem or Read/Write built-ins of its own. The child inherits the backend's environment; an org-scoped Anthropic credential, when a profile supplies one, overrides `ANTHROPIC_API_KEY` for that child only (`claude-runtime.js:92-94`). |
| `KUHN_AGENT_RUNTIME=pi` (preview) | `pi-adapter.js` | Runs in-process on `@earendil-works/pi-agent-core` / `pi-ai` against an explicit provider (`KUHN_PI_PROVIDER`: openrouter, openai, google, openai-compatible), model (`KUHN_PI_MODEL`), optional base URL and a **named** credential variable (`KUHN_PI_API_KEY_ENV`; `config.js:48-64`). Kuhn's per-agent Claude model ids are deliberately not reinterpreted. `provider_builtin` tools (hosted web search/fetch) are omitted — Pi only receives Kuhn tools with an `execute` (`pi-adapter.js:118-126`). |

There is no silent fallback: an unknown selector fails the boot (`index.js:155`,
`factory.js:41-49`) and a misconfigured Pi selection fails the task. Model profiles (below)
also pick the adapter per task: an `anthropic` profile runs on the Claude adapter, every
other provider on Pi (`factory.js:72-178`).

**Where the web tools run.** Claude's `WebSearch` is a provider-side (server) tool executed by
Anthropic. `WebFetch` is **not**: the bundled Claude Code CLI performs the HTTP fetch itself,
from the backend host's network, after a domain-blocklist preflight call to Anthropic; it
upgrades `http:` to `https:`, refuses dot-less hostnames, and does not automatically follow
cross-host redirects (verified in `@anthropic-ai/claude-agent-sdk` 0.3.277 —
`sdk.d.ts` describes WebFetch as an "in-process" tool, and the bundled CLI's fetch path issues
the request locally). WebFetch egress is therefore governed by the backend host's network
policy, not by Anthropic's; see the [threat model](security/threat-model.md) §4.1.

**Kept from the original design:**

- **DB-backed prompts** — agent system prompts in SQLite, seeded from `agent-backend/src/db/prompts/*.md`
  (+ `seed-data.js`), editable at runtime
- **Conversation logging** — every message, tool call, and response persisted (audit, replay,
  future semantic search)
- **Markdown files as agent handoffs** — the filesystem is shared memory; the project directory
  is the coordination medium (battle-tested in the CLI workflow)
- **Deterministic orchestration** — multi-agent pipelines (e.g., setup wizard → parallel RA and
  Advisor research → Writer skeleton) are code that dispatches agent tasks, not an agent
  improvising control flow

**Added:**

- **Durable job model** — long-running agent work (seeding, full review) is a persisted job with
  task state, progress streaming to the UI, resumability after crash, and per-run token budgets.
  A follow-up whose provider session is gone (typically after a budget stop) never fails on the
  dead id: the runtime continues in a fresh session seeded from Kuhn's own transcript of the old
  one (`agents/session-handoff.js`, issue #109). A budget stop is a *pause*, not a failure
  (issue #110): before the terminal event the runtime distills a hand-off note from the
  conversation (`agents/handoff.js`), stores it on the job, and the chat shows a durable pause
  card — rebuilt from the job row after a reload — whose Resume calls
  `POST /api/agent/jobs/:id/resume` (`agents/budget-pause.js` owns the vocabulary). Org owners
  can additionally cap spend per member and per project per UTC day/week/month (org settings
  `user_token_budget` / `project_token_budget` / `budget_period`, per-row overrides and manual
  resets in `org_budgets`, `db/org-budgets.js`): the tightest remaining allowance caps each
  top-level run's budget, an exhausted allowance refuses the run (`budget_exhausted`), and usage
  is the sum of `jobs.weighted_tokens` — tokens weighted by model cost relative to the top tier.
  A run can be **stopped** by the user (issue #136): `POST /api/agent/jobs/:id/cancel` on the
  top-level job (`agents/runtime.js` `cancelRun`) interrupts the in-flight provider turn,
  releases a parked `ask_user`, tears down every dispatched sub-agent through the parent's abort
  signal (each job row marked `cancelled`), and the run's stream ends with a `cancelled` event
  carrying the provider session and canonical continuation — so the next message continues from
  where it stopped. The chat's send button doubles as Stop while a run is in flight (Esc too);
  the status bar follows the innermost *running* job via `dispatch_agent`'s `job` markers
  (issue #137, `webapp/src/run-tracker.ts`). Token-free check: `npm run stop-check` in `webapp/`.
  **Parallel chats** (issue #113 item 2): the webapp keeps one run per chat (project + agent,
  `webapp/src/chat-runs.ts`) and one log per project, so a project switch leaves every stream
  open and Stop / the status bar / answer mode follow the chat in view. Server-side a chat turn
  is kept alive on any consumer disconnect (`runtime.js` `keepAlive`; its channel drops
  `text_delta` frames while unattached), `GET /api/agent/live` lists the caller's live runs in
  a project and `POST /api/agent/jobs/:id/reconnect` re-attaches — the reload path until #118
  stage 3 replays `job_events` by cursor. Token-free check: `npm run parallel-check`.
- **Model profiles and per-role routing** (issues #107/#111/#112) — an agent's model is
  resolved at dispatch time by `agents/model-routing.js` from the org's ranked route list
  (`agent_model_routes`: profile × difficulty ceiling) over *model profiles*
  (`db/model-profiles.js`): deployment-managed profiles derived from config (the operator's
  Anthropic key behind the seeded `agents.model` ids, the `KUHN_PI_*` preview) plus org-owned
  rows naming a provider (`anthropic` / `openai` / `openrouter` / `google` / `openai-compatible`), model id,
  endpoint, declared capabilities, cost weight, and a credential *reference* (an org secret
  name — the value is resolved server-side into the adapter constructor and nowhere else;
  an `openai-compatible` endpoint may be plain `http:` for a local vLLM/Ollama, and a
  non-loopback `http://` URL sends project content in clear text — use `https://` beyond
  localhost). A task's difficulty (0..1; `dispatch_agent`'s `difficulty`, or the REST body) picks the
  cheapest profile trusted with it; no route means today's deployment default. A profile that
  cannot run an agent is refused before a job exists (`route_invalid`). Jobs record
  `profile` and `endpoint` beside `provider`/`model`. Owners manage all of it under
  Settings → Models (`routes/model-profiles.js`, with a synthetic connectivity probe in
  `agents/model-probe.js`). Spec: `docs/specs/107-model-profiles-and-routing.md`.

**Historical consequences, now under revision:**

- The first implementation used SDK tool/MCP wrappers rather than a neutral tool registry;
  STH-1 extracts Kuhn's tool definitions without changing their storage/domain behavior.
- A raw provider-agnostic chat-completion interface remains rejected. The new seam is an agent
  execution contract with normalized events, tools, abort, usage, errors and canonical
  Kuhn-owned continuation messages.

## Multi-Tenancy Invariants

Three invariants were adopted from the start so that full multi-tenancy would be auth +
quotas, not a rewrite (epic 011 built on them — see the roles section below):

1. **Everything is project-scoped.** Every DB row and file path carries a `project_id` (and a
   tenant/owner column from the start, even while it has one value). A future multi-tenant
   path (e.g. a hosted Postgres) is then `tenant_id` + row-level security, not a rewrite.
2. **One storage API, project-root enforced.** All agent and frontend file access goes through a
   single storage service that resolves paths inside the project root — no traversal, no symlink
   following. Agents never get raw filesystem access outside their project.
3. **All execution is sandboxed, even single-user.** Typst/Pandoc rendering, Marp slide decks,
   poppler PDF ingestion, and analyst scripts (R today — `RUNNABLE_LANGUAGES`, `sandbox.js`)
   run in a fresh `docker run --rm` container **per invocation** (not per session) built by
   `buildDockerArgs` (`sandbox.js:33-57`): `--network none`, project mounted read-only, a
   separate writable `/out`, CPU/memory/pids caps and a kill timer. Image and argv are composed
   server-side; agents choose only the script and constrained arguments. Secrets-enabled script
   runs join the operator-created **internal** docker network (`SANDBOX_SECRETS_NETWORK`,
   `sandbox.js` `runScriptSandboxed`) instead of `--network none`. Container hardening and
   removing the web process's direct Docker access are pending (ADR 002 §6, STH-21).
   Document compilation is arbitrary code execution; treat it that way from day one.

Yjs rooms are membership-authorized at upgrade time (story 007-003) and role-aware since
010-003: viewers get read-only sockets, and a 60-second member sweep closes live sockets on
removal, demotion, or org suspension (close code 4006; reconnects re-authorize).

### Roles & Organization Administration (010-003 / epic 011)

Membership carries a role — `viewer < editor < owner` — and every role/suspension decision
funnels through one chokepoint, `checkOrgAccess` (`db/orgs.js`), reached from routes via
`routes/guards.js` (`requireProjectRole` / `requireOrgRole`). The error discipline is uniform
and non-leaking: unknown-or-not-yours → 404, insufficient role → 403 `requires <role> role`,
suspended org → 403 `organization suspended`. Reads need viewer; anything that mutates a
project, its files, or org content needs editor; member management, invitations, org settings
(rename + `default_member_role` / `library_seeding` / `promotion_policy`), shared-library
deletion, and the promotion-approval queue are owner-only. Invitations are the only door into
an org outside dev mode (single-use hashed tokens through the magic-link verify endpoint) —
and since STH-35 they are the only door into the **install** as well: sign-in is invite-only,
a magic link is issued only to an address that already holds a membership (or the super-admin
flag), and everyone else lands in a super-admin-reviewed `access_requests` queue instead of
get-or-creating an account. An org must always keep at least one owner. Separately, `users.is_superadmin` is a **platform**
flag (synced from `KUHN_SUPERADMIN_EMAILS` at boot), not a role: super-admins provision,
rename, suspend, and unsuspend orgs via `POST /api/orgs` + `/api/admin/orgs`, but **no tenancy
guard consults the flag** — a super-admin without a membership is a stranger to every org's
content. The sanctioned way in is explicit: `POST /api/admin/orgs/:id/join` (STH-36, the
platform console's "Open" action) writes a normal, audited owner membership, after which
content access flows through that membership like anyone else's. Suspension refuses members everywhere through the same chokepoint while the
`/api/admin` surface stays open (that is how an org is unsuspended). The whole contract is
regression-locked by `routes/tenancy-matrix.test.js`, which sweeps every tenant-scoped route
across principals × org status.

### Knowledge Base Tenancy

The advisor's knowledge base is **per-tenant by default**:

- **Tenant KB** — guidance summaries, source docs, and project knowledge belong to the tenant
  that uploaded them. Never shared across tenants. This is a sales requirement in the target
  market (FDA/clinical/grant writers will ask about data isolation before uploading a protocol).
- **Kuhn knowledge library** (issue #65 spec; catalog modules restored in
  [PR #70](https://github.com/soundtrip-health/kuhn/pull/70)) — a separate, Kuhn-curated, read-only
  catalog of public guidance organized as selectable **knowledge packages** (reporting
  standards, FDA/ICH regulatory guidance, style references), defined by
  `guidance-docs/catalog.json` and seeded into `knowledge_packages`/`knowledge_items` at
  startup. Org owners enable packages or individual items (org admin → Knowledge tab);
  enabled items are imported per-org into `org_documents` (source `guidance-import`, linked
  by `catalog_item_id`) through the same ingestion/FTS pipeline as uploads, so
  `search_org_knowledge` needs no changes. Tenant uploads never flow into the catalog;
  curation is an explicit, Kuhn-side editorial act, and a catalog version bump surfaces as
  an explicit per-org "update available" state rather than an automatic re-import.

## Identity, Credentials and Secrets

### Sign-in and sessions

- **Auth modes** (`KUHN_AUTH_MODE`, `config.js:100`). `dev` (the default) has *no*
  authentication: the `x-kuhn-user` header or the seeded dev user is the identity
  (`session.js:186-190`) and must never be network-exposed. Any other value (canonically
  `magic-link`) requires a signed session cookie on every request and refuses to boot without
  `KUHN_SESSION_SECRET` (`assertAuthConfig`, `session.js:61`, called at `index.js:152`).
- **Magic links.** `POST /api/auth/request-link` always answers `200` and decides by mailbox
  only: member → single-use sign-in link (15-minute TTL), pending invitee → re-issued
  invitation, stranger → access-request queue (`routeSignIn`, `routes/auth.js:113-145`).
  Tokens are random and stored hashed (`db/auth.js:47-75`). Per-email and per-IP limits
  (`config.js:136-141`, `rate-limit.js`).
- **Sessions** are DB-backed rows keyed by the hash of a random token; the cookie
  `kuhn_session` carries that token plus an HMAC-SHA256 signature under
  `KUHN_SESSION_SECRET`, verified with `timingSafeEqual` (`db/auth.js:19-37`, `:77-110`).
  Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` when `KUHN_APP_URL` is https
  (`routes/auth.js:92-97`); 30-day default TTL (`config.js:105`).
- **Public origin for emailed links.** Magic links, invitations and review links are built by
  `publicUrl()` from `KUHN_APP_URL` only — never from the request's `Host` /
  `X-Forwarded-Host` (`public-url.js:9`; used at `routes/auth.js:117,130`,
  `routes/orgs.js:111`, `routes/org-admin.js:286`, `routes/access-requests.js:94`,
  `routes/review-links.js:80`; PR #200).
- **Network posture.** The backend binds `KUHN_HOST` (default `127.0.0.1`, `config.js:26`) and
  sets Express `trust proxy` to `KUHN_TRUST_PROXY` (default `loopback`, `index.js:55`), so
  `X-Forwarded-*` is honoured only from a proxy/tunnel on the same host.
- **External reviewers** use a separate review-link cookie on `/api/review/*`, mounted before
  `session()` (`index.js:65-69`, `review-auth.js`).

### Personal API tokens

`Authorization: Bearer kuhn_…` (issue #152) is checked **first, in every auth mode**
(`session.js:170-185`). Tokens are `kuhn_` + 32 random bytes (base64url), stored only as
SHA-256 in `api_tokens`, expire after 90 days by default (max 365), and are revocable
(`db/api-tokens.js:18-20`, `:54-74`). A valid token resolves to the same `users` row a cookie
would — including `is_superadmin` — so guards, tenancy and attribution are unchanged
(`db/api-tokens.js:107-120`); an invalid token is refused outright and never falls back to
the cookie or dev header. A token cannot mint, list or revoke tokens (`requireSessionNotToken`, `routes/auth.js:290-296`).
Mint/revoke are audited in `auth_events`.

### Org secrets store

Named, org-scoped credentials (a data-warehouse DSN for analyst scripts, a provider API key
for a model profile) — `db/org-secrets.js`, `routes/org-secrets.js`:

- **Write-only.** The HTTP surface lists metadata and accepts `PUT`/`DELETE` (editor role and
  up); values are never returned. Saves/deletes are audited with the *name* only.
- **Encrypted at rest** with AES-256-GCM (random 96-bit IV, auth tag) in `org_secrets`
  (`db/org-secrets.js:64-76`). The key is `KUHN_SECRETS_KEY` (64 hex chars); when unset it is
  derived with scrypt from `KUHN_SESSION_SECRET`, and with neither a fixed dev key is used
  (`db/org-secrets.js:41-57`, `config.js:222-227`). Production should set a dedicated
  `KUHN_SECRETS_KEY` held outside the data backup (threat model TB-7).
- **Use sites.** (1) Analyst `run_script` calls that name `secrets: [...]`: values are
  resolved server-side (`agents/tools/scripts.js:196`) and injected into that one sandbox as
  `KUHN_SECRET_<NAME>` environment variables (`secretEnvName`, `db/org-secrets.js:36`), and
  the run joins the internal data network. The agent sees names only (`list_secrets`).
  (2) Model profiles reference a secret by name; `resolveCredential`
  (`agents/model-routing.js:172`) hands the value to the adapter constructor and nowhere else.
  Lookups are keyed by `(org_id, name)`, so one org cannot name another's secret.

## Interchange with External Writing Tools

Kuhn can act as the **feedback surface** for a manuscript whose source of truth lives in
another tool (first client: sciwriter). The contract is a zip **interchange bundle** and
three endpoints — `docs/specs/interchange-bundle.md` is the normative spec; this section is
the map.

- **Identity.** External tools call the API as a Kuhn user with a **personal API token**
  (`Authorization: Bearer kuhn_…`, minted in the account menu, `api_tokens` stores the
  sha256). `session.js` checks the bearer header first, in every auth mode; the token
  resolves to the same `users` row a cookie would, so guards, tenancy and attribution are
  unchanged. A token cannot mint or revoke tokens.
- **Bundle.** `manifest.json` (provenance, project spec for creation, the doc list with an
  opaque per-doc `meta`), optional `references.json` (keyed by the tool's cite keys), and
  `files/<workspace path>` for docs and assets. Paths are Kuhn workspace paths; relative
  links inside docs resolve against the doc's directory, so assets sit under it.
- **Import** (`POST /api/projects/import` creates, `POST /api/projects/:id/import` updates;
  `src/interchange/`). The zip is fully validated before a byte is written (safe paths,
  size/entry caps on declared sizes, UTF-8 docs, cite-key grammar). References are
  upserted **under the supplied key** (`db/references.js` `upsertReferenceByKey`); when
  dedup or a collision forces another key, `[@key]` citations in the bundle's docs are
  rewritten and the map is returned. Writes go through `storage.js`, bracketed by two
  history checkpoints, followed by `file_change` events (activity log, idle-room eviction,
  reviewer-room refresh), `references.bib` materialization and server-side re-anchoring of
  existing comments. A doc a member holds open in the editor makes the import refuse with
  `409 doc_open`; `force=1` evicts that room with the terminal *document replaced* close
  (4001), which the editor already handles — the reconnectable refresh close would let a
  member client re-seed the room from its own stale state. Provenance (source, checkpoint,
  per-doc sha256 and `meta`) is stored under the project's `interchange` config.
- **Export** (`GET /api/projects/:id/export?format=json|zip`, viewer role; the same URL
  with a document format — pdf, docx, tex, pptx, html — is the render service's export,
  and the interchange route hands those on to it). JSON is the
  feedback payload: current content, `modified_since_import`, comment threads with a
  normalized author (`member` / `reviewer` / `agent`) and anchors re-resolved in memory,
  all references, history head and last-import provenance. The zip form is the bundle
  layout plus `comments.json` and the docs' sibling assets, and imports back into Kuhn —
  the route tests prove export → import → export identity.
- **Everything else is the tool's problem.** Marker conversion, redlines against the
  pushed base, and turning comments into the tool's own syntax happen in the tool. Kuhn
  never inspects doc content beyond citation keys.

## Slash Commands

| Command | Agent | Action | Status |
|---------|-------|--------|--------|
| `/cite <query>` | `ra` | Search PubMed, insert `[@citekey]` + update `.bib` | implemented |
| `/write <request>` | `writer` | Contextual drafting/edits at cursor or selection | implemented |
| `/research <question>` | `ra` | Quick literature lookup, return summary | planned |
| `/figure <description>` | `analyst` | Generate a figure or table, insert it | planned |
| `/review` | `reviewer` | Critique the current section | planned |
| `/ask <question>` | `pm` | Ask any agent inline | planned |
| `/status` | `pm` | Project status summary | planned |

Defined in `webapp/src/slash-commands.ts:16-22` (the `implemented` flag); implemented as
ProseMirror/Milkdown plugins calling the agent-task API.

## Data Model

- Projects are directories on disk (git-trackable), accessed only via the Storage API
- Documents are markdown (`.md`); references canonically in SQLite, with `.bib` derived for rendering
- Figures and tables in `figures/` and `tables/`
- **Path is identity.** Files have no id column, deliberately — storage is the
  source of truth and every DB row that refers to a file is keyed by its path
  (`comments`, `pending_edits`, `file_seen`, `file_events`, and
  `projects.config.activeDocument`). A move is therefore not a delete plus a
  create: it is a tracked, identity-preserving `moved` event whose consumers
  are all re-keyed in one transaction (`db/move-paths.js`, story 012-002).
  Anything new that keys off a path must be added to that rewrite — the
  header comment there carries the authoritative audit of path columns.
  Path matching is **byte-exact**, so a case-only rename on a
  case-insensitive filesystem is not treated as a no-op.
- **Folders are just directories.** Nesting has always been allowed by the
  storage layer; story 012-001 exposes it in the UI. An empty folder is
  working-tree-only state — git cannot track it, so it survives reloads and
  the per-file restore, but it is invisible to version history.
- Agent prompts, conversations, jobs, references, and project metadata in SQLite (project/tenant-scoped)
- **Chats** (`chats`, issue #113): one durable row per (project, agent, user) holding the
  provider session id, the canonical continuation, the user's model pin and the fresh-start
  hand-off note; a top-level job is stamped with `jobs.chat_id` and the chat's `status` is
  projected at read time from its current job (no stored state until #118 stage 1). The client
  names the chat; the server resumes it — so two tabs or devices continue one conversation.
  `status` projects `waiting_for_user` while the run (or a sub-agent of it) is parked on
  `ask_user`, and every transition is announced on the org hub (`agents/activity.js`,
  `GET /api/orgs/:id/activity`) for the webapp's status marks (issue #113 item 3).
- Tenant KB under the tenant's storage; shared guidance corpus in a separate global store

## Decision Revisions (2026-06-11)

| Earlier decision | Revision | Why |
|---|---|---|
| TeXlyre fork as editor foundation (Epic 001, 2026-04-17) | Milkdown-based markdown editor; TeXlyre retired to reference | Audience is not LaTeX-native; agents are markdown-native; MIT removes AGPL burden |
| LaTeX primary / Typst supported | Markdown canonical; Typst renders; LaTeX + docx are exports | Formatting is automatable; deliverables are often Word |
| Two separate apps (AGPL isolation) | Single app | Isolation rationale was the AGPL license; gone with Milkdown |
| Custom agent router + provider-agnostic LLM interface | Claude Agent SDK behind an agent-task boundary | Don't rebuild an agent runtime; hedge lock-in at the task interface |
| Claude Agent SDK as the only execution kernel | Keep Claude as transitional reference; adopt Pi core/model primitives behind a Kuhn-owned execution contract ([ADR 001](adr/001-provider-agnostic-runtime-foundation.md)) | Freeze product semantics first, then gain multiple providers and custom endpoints without moving Kuhn policy into a framework |
| Multi-tenancy fully deferred | Three invariants now (scoping, storage API, sandboxing) + per-tenant KB / shared guidance corpus | Cheap now, expensive to retrofit; isolation is a sales blocker in target market |

## Open Questions

- [ ] Typst template library: which journal/funder targets first?
- [x] Suggestion-mode agent edits for protected draft paths
- [ ] Enterprise identity/SSO provider beyond the current magic-link system
- [ ] Server-side vs. client-side Typst rendering (server default; WASM later for offline)
