# ADR 002: Production deployment topology and scale boundary

- **Status:** Proposed for human architecture review
- **Date:** 2026-08-17
- **Issues:** STH-3 (this ADR); informs STH-17, STH-21, STH-22, STH-23,
  STH-24, STH-25, STH-26, STH-27, STH-29
- **Companion:** [threat-model.md](../security/threat-model.md) (STH-2) — the
  security model and this topology constrain each other and were written as one pass.
- **Relationship to ADR 001:** ADR 001 (provider-neutral runtime) is **landed on
  `main`** at [`docs/adr/001-provider-agnostic-runtime-foundation.md`](001-provider-agnostic-runtime-foundation.md)
  (merged in [PR #69](https://github.com/soundtrip-health/kuhn/pull/69), which added
  the provider-runtime contract, continuation, and Pi spike under
  `agent-backend/src/agents/provider-runtime/`). This ADR references its direction (a
  narrow `AgentRuntime` seam beneath `runAgentTask`, implemented in phases under
  STH-1/STH-7) but does not depend on that implementation's internal details.

## Review orientation

This PR changes architecture documentation only. It does not make the current build
production-ready.

| State | Topology | Meaning |
|---|---|---|
| **Current implementation** | One Node process owns HTTP, agent execution, live SSE/Yjs state, SQLite access, local files, and direct Docker invocation | Useful development baseline, with the security and durability gaps catalogued in the companion threat model |
| **Proposed first-team target** | One host; one web process, one durable-job worker, and one narrowly scoped sandbox service; shared SQLite and local files | The smallest supported production topology this ADR asks a human reviewer to approve |
| **Later scale topology** | Multiple web/worker hosts, Postgres, shared/object storage, externalized collaboration/event coordination | Deferred until measured contention, availability, or capacity triggers require it |

The consequential review questions are whether the worker seam is recoverable, the
sandbox boundary removes arbitrary Docker control from the web process, SQLite is an
honest supported boundary for the pilot, and the backup contract can be implemented and
tested by the owning STH issues. Provider replacement, multi-region operation, and
generic multi-tenant SaaS scale are non-goals here.

## Context

Today Kuhn is **one Node process** serving REST, the static webapp, SSE, and Yjs
collaboration WebSockets, with **in-process SQLite** (WAL), **local project/org files**,
**in-memory** live-run and pub/sub registries, and **direct Docker execution** for
rendering/ingestion (`index.js:94-129`, `db.js:14-21`, `sandbox.js:56`). That is simple
and genuinely useful, and much of it is well-disciplined — a single storage chokepoint
with symlink-proof containment (`storage.js:80-114`), per-project git history, a
credential-free sandbox environment, and a tenancy chokepoint the super-admin flag never
bypasses (`db/orgs.js:33-59`).

But the production boundary must be explicit before the reliability issues in milestones
3–4 each make a local topology choice. Two properties of the current process are
load-bearing and set the terms of every decision below:

1. **Everything is one trust zone.** The request handler, the agent runtime, the SQLite
   file, the project files, and the **host-root-equivalent Docker socket** all live in
   one OS process on one host. (Threat model §1, T-25.)
2. **The database is synchronous and single-writer.** better-sqlite3 blocks the event
   loop on every query (`db.js:63-65`). Kuhn does not configure a timeout explicitly,
   so the library's current 5-second default applies (`db.js:19`;
   [better-sqlite3 `Database` constructor](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#new-databasepath-options)).
   A competing writer can therefore block the process and may
   still end in `SQLITE_BUSY`. That latency/contention boundary — not an immediate-fail
   assumption — is what the scale triggers key off.

### First production target

**Not hyperscale SaaS.** The first real deployment is a **small scientific/technical
writing team** (single organization, or a handful) using Kuhn for valuable, sensitive
work: unpublished manuscripts, grant material, protocols, org knowledge, uploaded
sources, reviews, agent transcripts, citations, and model/provider credentials. The
goal is **the smallest architecture we can reasonably call production-safe** — not the
most enterprise-looking one. We do **not** introduce distributed infrastructure for
aesthetics; we also **do not** keep a prototype shortcut that creates a real
confidentiality, integrity, durability, recovery, or host-compromise risk.

Every decision below states: **(1)** the pilot choice, **(2)** why, **(3)** alternatives
considered, **(4)** the operational/security tradeoff, **(5)** the scale ceiling or
trigger that forces a revisit.

## Decision summary

| Area | Pilot decision | Hard trigger to revisit |
|---|---|---|
| Web/API | **Single instance**, single port, behind a reverse proxy | Need for a second web replica for availability, or CPU-bound request serving |
| Background jobs | **Split into a dedicated worker process** on the same host, sharing the DB and files, with DB-backed leases, **a DB-backed durable event/control seam** (§2.3), and **deduplication/recovery protocols for mutating tool calls** (§2.4) | Worker CPU saturation or measured DB contention; additional workers remain a deliberate post-pilot topology |
| Database | **Keep SQLite** (WAL, single writer), accessed by web + worker on one host | Sustained write contention / latency or need for a second host to touch data → **Postgres** |
| File storage | **Local durable disk**, backed up with the DB | Multi-host access to files; capacity beyond one volume → network/object storage |
| Collaboration (Yjs) | **Single-instance in-memory rooms**, durability via autosave | Any second web instance that terminates WebSockets |
| Sandbox | **Dedicated local sandbox service** with a narrow enumerated request surface; the *only* Docker client; web/worker call it over local RPC; **interactive render/export stays synchronous** (§6) | — (this is itself the hardening; larger isolation only if multi-host) |
| Reverse proxy / TLS | **Required**; credential URLs minted from the **canonical configured origin**, never request Host; bounded `trust proxy` for request metadata only | Multi-instance → real load balancer |
| Backup/restore | **Two recovery domains**: encrypted data backup (SQLite online-backup destination + files + orgs, under a brief write barrier) and a **separate secret escrow**; app version recorded (§8) | Backup window exceeds tolerance → incremental/streaming |
| Deployment artifact | **Immutable container image** for the server components (incl. `guidance-docs/`) + digest-pinned sandbox images | — |
| Observability | Structured logs + **component-specific** readiness: web stays ready when worker/sandbox/provider degrade; affected endpoints 503 (§10) | — |

The through-line: **keep request-serving simple and single-instance; separate the two
things that are genuinely unsafe or unreliable co-resident — durable background
execution (STH-25) and host-privileged Docker control (STH-21); make persistence
recoverable (STH-22/STH-23); and build the *seam* for multi-instance later rather than
paying its cost now.**

## Pilot topology (target state)

The diagram below is the **target production-pilot topology** this ADR decides —
three processes on one host, coordinating through SQLite as the durable seam. (The
*current-implementation* trust-boundary diagram — one process, direct Docker — is in
the [threat model §1.1](../security/threat-model.md); the two are deliberately
different pictures.)

```mermaid
flowchart TB
  subgraph Clients["Untrusted network"]
    Member["Member browser"]
    Guest["External reviewer browser"]
  end

  RP["Reverse proxy (operator-provided)<br/>TLS termination, WS/SSE forwarding,<br/>body/timeout limits, strips client X-Forwarded-*"]

  subgraph Host["Single production host"]
    subgraph Web["Web/API process — no Docker access"]
      API["HTTP/REST + static webapp<br/>member/guest auth<br/>credential URLs from canonical origin"]
      Live["Web-local live state:<br/>SSE hubs · Yjs rooms · reviewer sockets<br/>move tombstones (projections only)"]
    end
    subgraph Worker["Worker process — no Docker access"]
      Jobs["Durable agent jobs: leases, provider turns,<br/>Kuhn-owned continuation, background ingestion,<br/>git-history commits<br/>bounded per-class concurrency"]
    end
    subgraph SbxSvc["Sandbox service — the only Docker client"]
      SbxAPI["Narrow enumerated request types:<br/>render · export · ingest-extract<br/>own concurrency cap + queue"]
    end
    DB[("SQLite (WAL)<br/>domain data · jobs + leases<br/>ordered job/domain event rows<br/>pending questions · replies<br/>cancel + suspension flags")]
    Files[["data/files/ + per-project .git<br/>data/orgs/ originals"]]
    Env["agent-backend/.env<br/>(secrets — never in data backup)"]
    Docker{{"Docker daemon"}}
    Cont["Sandboxed containers<br/>Typst / Pandoc / poppler<br/>--network none · :ro mounts · digest-pinned"]
  end

  subgraph Egress["Outbound egress"]
    Provider["Model provider API"]
    Research["PubMed / arXiv"]
    SMTP["SMTP relay (login/invite mail)"]
  end

  subgraph Recovery["Recovery domains — separate trust zones"]
    Backup[("Encrypted data backup<br/>online-backup DB destination,<br/>files, orgs, recorded app version")]
    Escrow[("Secret escrow<br/>KUHN_SESSION_SECRET, future master key;<br/>provider creds preferably reissued")]
  end

  Member --> RP
  Guest --> RP
  RP --> API
  API --> Live
  API <-->|"web-originated mutations<br/>+ their event appends"| DB
  DB -->|"ordered durable event tail<br/>(drives SSE + Yjs/reviewer invalidation)"| Live
  API -->|"persist reply / cancel<br/>(+ optional local wakeup)"| DB
  Jobs <-->|"claim/lease · append events<br/>read replies, cancel, suspension"| DB
  API <--> Files
  Jobs <--> Files
  API -->|"synchronous render/export RPC"| SbxAPI
  Jobs -->|"ingest-extract RPC"| SbxAPI
  SbxAPI --> Docker --> Cont
  Cont -.->|":ro mounts"| Files
  Jobs --> Provider
  Jobs --> Research
  API --> SMTP
  Web -.reads at boot.-> Env
  Worker -.reads at boot.-> Env
  DB -.->|"write barrier §8.5"| Backup
  Files -.->|"write barrier §8.5"| Backup
  Env -.->|"separate domain §8.3"| Escrow
```

What the picture pins down: the **web↔worker seam is SQLite** — ordered durable
event rows flowing worker→web, persisted control state flowing web→worker (§2.3);
the web process alone owns live connections (SSE, Yjs, reviewer sockets); the worker
alone talks to the model provider and research APIs; the sandbox service alone talks
to Docker; and the backup and secret-escrow destinations are separate trust
domains.

---

## 1. Web/API topology

**Decision:** one web/API instance for the pilot, single port (default 3002), behind a
TLS-terminating reverse proxy. Unchanged from today except that background execution and
sandbox invocation move out (below).

**Why:** a small team's request load is trivial; the app already serves REST + static +
SSE + WS from one port (`index.js:94-129`), which eliminates CORS and cookie-scope
configuration (`deployment.md:168-181`). A second instance would immediately break two
things that are in-memory and single-owner today — Yjs rooms and the SSE/live-run
registries — for **zero pilot benefit**.

**Alternatives considered:** (a) multi-instance web behind a load balancer — rejected:
no pilot need, and it forces Yjs coordination (§5) and sticky sessions we don't want to
pay for yet. (b) Serverless/function split — rejected: incompatible with long-lived
SSE/WS and in-process agent runs.

**Operating envelope (supported):** one organization or a few; low tens of concurrent
users; a handful of concurrent agent runs; Yjs editing within a small team per
document. The **SSE subscriber cap is 20 per project/org** (`config.js:125`) — a real
ceiling to raise deliberately, not a load limit to discover.

**What cannot safely remain inside the web process:**

- **Durable background/agent execution** — today live runs are in-memory objects on the
  request event loop (`runs.js:22-42`); a restart marks them `interrupted`
  (`db/jobs.js:135-141`) and loses in-flight work. → dedicated worker, §2.
- **Docker control** — direct `docker` CLI invocation makes the web process host-root
  equivalent (`sandbox.js:56`). → sandbox worker, §6.

**Scale trigger:** move to multiple web replicas only when a single instance is
CPU-bound on request serving *or* availability requires no-single-point-of-failure. That
step **requires** externalizing Yjs coordination (§5) and the SSE/run registries, and
almost certainly Postgres (§3) — it is a topology change, not a config flag, and this
ADR deliberately defers it.

---

## 2. Background jobs — the worker and the web↔worker seam

**Decision:** move durable agent/background execution into a **dedicated worker
process** on the **same host**, sharing the same SQLite database and the same file
volume, coordinating through **DB-backed job leases and a DB-backed, append-only
durable event/control seam** (§2.3). SQLite *is* the channel; no broker, no Redis. Not
a separate service tier — a second Node process supervised alongside the web process.

**Why:** durable execution is the one part of the runtime that is unsafe co-resident with
request serving. Today a deploy/restart or a crash loses in-flight runs, parked
`ask_user` runs live forever with unbounded event buffers (`config.js:87-90`,
`runtime.js:179-184`), and org suspension doesn't stop a running job
(`runtime.js:1029-1033`). A worker with an explicit lifecycle fixes all three without a
broker.

### 2.1 Process ownership

| Process | Owns |
|---|---|
| **Web/API** | HTTP/API; member/guest auth; SSE connections; Yjs/WebSocket rooms and the signaling endpoint; reviewer socket registries; move tombstones and every other client-facing **live projection**; web-originated durable mutations (editor uploads/moves/deletes, org-library writes, admin/review state) |
| **Worker** | Durable agent-job execution; provider/model calls; research-API calls; job leases and lifecycle; resumable Kuhn-owned continuation (ADR 001); background ingestion; git-history commit execution (§2.4); appending job/domain events for its own work |
| **Sandbox service** | Docker/container invocation **only** — a narrow, enumerated set of render/ingest request types (§6); never an arbitrary command interface |

### 2.2 Why "just move `runAgentTask`" is not enough

Current job/event semantics are **process-local**, and naively relocating the runtime
would break product behavior. A top-level `runAgentTask()` constructs an `EventChannel`
whose `onEvent` calls `publishProjectEvent()` (`project-events.js:64`), and that hub
owns real product invariants, not just UI fan-out: file-activity persistence
(`recordFileEvent`), path-keyed DB rewrites on moves (`applyMove`, transactional with
the activity row), review-link revocation on delete, closing the revoked links' live
reviewer connections, Yjs room eviction, move tombstones and clearing them on new
writes, reviewer-only-room refresh, git-history scheduling and terminal-job commits,
and finally SSE fan-out to in-memory subscribers. Separately, `runs.js` holds live run
handles and `questions.js` holds pending `ask_user` waiters in in-memory `Map`s, and
`/reply`, `/pending`, and `/reconnect` execute against those maps in the web process
(`routes/agent.js:122-167`). Move the runtime to a second process without replacing
these seams and the worker's copy of the hub has no subscribers, no rooms, and no
reviewer sockets — while the web process can no longer deliver replies or reconnects
to the run. The contract below is what STH-25/STH-24 build to.

### 2.3 The durable event/control seam (the pilot contract)

DB-backed in both directions. **Correctness never depends on an ephemeral channel;
restart correctness comes from persisted state.**

- **Worker → web: ordered durable events.** The worker appends job/domain events —
  job lifecycle transitions, agent output, `file_change`, question-asked, org
  `doc_status`, terminal state — as **append-only rows with a per-job monotonic
  sequence** (project/org events additionally ordered per scope). The web process
  tails these rows and serves its SSE/client projections and room invalidations from
  them. A local wakeup (Unix domain socket or similar) MAY be used to shorten tail
  latency, but it is an optimization only: a dropped wakeup or a dead socket loses
  nothing, because the next tail read sees the rows.
- **Web → worker: persisted control state.** `ask_user` replies, cancellation, and
  project/org suspension are **persisted control rows/flags** the worker reads at
  defined points — before each provider turn, on lease renewal/heartbeat, and when
  unparking a question. `POST /jobs/:id/reply` becomes "persist the reply, then wake
  the worker"; `GET /pending` and `POST /jobs/:id/reconnect` read durable
  question/job state instead of the in-memory maps. The pending-question row (question
  text, asking agent, asked-at) is itself durable state, published as an event and
  queryable.
- **Delivery is at-least-once; every replayable consumer effect is idempotent.** The
  web tracks the last event sequence it projected; SSE clients carry a cursor
  (`Last-Event-ID`-style) so a browser reload replays from where it left off. Nothing
  correctness-bearing lives only in web-process memory. This requires a deliberate
  wire-protocol change: the current project/org feeds emit `data:` frames but no stable
  SSE `id:` and the client relies only on `EventSource` auto-reconnect
  (`routes/projects.js` project-event route; `webapp/src/api.ts` project-event
  subscription). STH-25 must add event IDs, retention/cursor rules, and
  `Last-Event-ID` resume behavior before replay is a valid claim.
- **Restart matrix:**
  - *Browser reload:* the client resubscribes with its cursor; the pending question is
    re-emitted from the durable question row.
  - *Web-process restart:* live connections drop; on restart the web re-tails the event
    rows and rebuilds projections; clients reconnect with cursors. No event is lost.
  - *Worker restart / reclaim:* the lease expires; the job is reclaimed and resumes
    from Kuhn-owned continuation (ADR 001). The continuation checkpoint records the
    last appended event sequence, so a resumed job continues the sequence instead of
    double-appending. Any mutating tool operation the crash left `prepared`/ambiguous
    is reconciled against actual state per §2.4 **before** the run resumes. A parked
    question survives as durable state across the restart.
  - *Terminal state:* the terminal job event row is the durable truth; the live-run
    registry (`runs.js`) becomes a derived cache over jobs + events, not the authority.

### 2.4 Durable mutation effects — identity, deduplication, reconciliation

**The production invariant:** recovery never blindly repeats a mutating operation.
Kuhn guarantees one committed DB effect/result/event per Kuhn-owned operation identity
for DB-only work. For filesystem-backed work, SQLite and the filesystem cannot commit
atomically, so the honest target is narrower: persist intent and preconditions, fence
concurrent mutation, reconcile an ambiguous outcome, and either finalize, safely retry,
or stop for repair. The architecture does **not** promise generic exactly-once
filesystem effects.

`publishProjectEvent()` today conflates two kinds of effect. The corrected split:

1. **Authoritative durable mutations** — `recordFileEvent`, `applyMove`'s path-keyed
   rewrites, and review-link revocation (the DB half) — are owned by
   **the process that originates the mutation**, executed under the operation
   protocol below. Worker-originated file changes: the worker. Web-originated
   editor/REST mutations: the web process (reconciled at web startup — see "Recovery
   ownership and trigger" below). **Neither process ever
   re-executes the other's durable mutations when consuming an event row** — the row
   is the *record* that the mutation already happened, never an instruction to redo
   it. This is what rules out double-application (a move applied twice, a link
   revoked twice against a recreated path, a file event recorded twice).
2. **Web-local live projections** — Yjs room eviction, move tombstones and their
   clearing, closing reviewer sockets after a revocation, reviewer-only-room refresh,
   SSE fan-out — happen **only in the web process**, which owns those live
   connections: inline for web-originated events, via the durable tail for
   worker-originated ones. All are idempotent against live connection state (evicting
   an absent room, closing an already-closed socket, re-planting a tombstone are
   no-ops), which is what makes at-least-once delivery safe.

**The operation protocol (what STH-25 builds; STH-24 verifies):**

- **Kuhn-owned operation identity.** Kuhn mints the logical operation id from durable
  job/step state and reuses it only when resuming that same recorded operation. A
  provider tool-call id is useful transcript evidence, but is not the idempotency key:
  rerunning a provider turn may produce a different id, and two different logical
  attempts must not collide merely because a provider reuses one. STH-1 and STH-7
  must carry the Kuhn operation context through the neutral tool boundary; the
  runtime's canonical provider tool-call ids (landed in #69) alone do not establish
  replay identity.
- **Durable operation state.** Conceptually, persisted operation state carries: the
  operation id; job and durable step; tool/capability; normalized arguments (or a safe
  hash); required precondition/version; intended postcondition; a state such as
  `prepared` / `applied` / `ambiguous` / `failed`; stored result; and associated event
  sequence. This ADR does not fix the final schema. It fixes the protocol: preparation
  precedes the effect, and an applied operation returns its stored result.
- **DB-only mutations.** Where a tool's side effect is entirely SQLite-backed,
  operation finalization + the mutation + the domain-event append commit in **one
  SQLite transaction**. A uniqueness constraint on the Kuhn operation id makes replay
  return the stored result without applying a second DB mutation. Review-link
  mint/revoke and other web/admin mutations remain web-owned DB operations; if an API
  endpoint promises safe client retries, the web must assign or accept a Kuhn request
  id and apply the same uniqueness/result rule rather than borrowing a provider id.
- **Filesystem-backed mutations** follow a durable **prepare → execute →
  reconcile/finalize** contract. Preparation records the exact precondition (for
  example absent/existing path, content hash or version, and destination state) and
  acquires a project/path mutation fence. After the filesystem effect, one DB
  transaction records path-keyed DB changes, event rows, operation result, and the
  continuation checkpoint that follows the tool result. Recovery then compares both
  the precondition and intended postcondition:
  - `write_file`: desired content at the path is evidence only while the recorded
    path/version fence excludes a later writer; a matching hash by itself cannot prove
    which operation wrote it.
  - `move_file`: source identity and destination precondition must be recorded before
    rename. Source-missing/destination-present is not automatically attributable when
    another actor could have changed either path.
  - create/delete use the same precondition rule; absence alone is not proof that a
    particular delete ran.
- **Ambiguity is a supported recovery state.** If current state cannot prove that the
  recorded effect landed or did not land, the reconciling process marks the operation
  `ambiguous`/dead-letter and requires a tool-specific repair path. It does not guess.
  STH-25 builds these protocols; STH-24 and STH-30 verify them with crash and
  concurrency injection.

**Recovery ownership and trigger — every prepared operation has a finder.** The
operation store carries an **originator** column (`web` | `worker`); each process
reconciles only the operations it owns, so the two never race to recover the same row.
The reconciliation *trigger* differs by originator, because only worker jobs are leased:

- **Worker-originated operations** recover through the **lease lifecycle** (§2.5): a
  dead worker's lease expires, the job is reclaimed, and the reclaiming worker
  reconciles any `prepared`/`ambiguous` operation for that job *before* the run
  resumes. The lease expiry is the trigger.
- **Web-originated operations have no lease** — editor autosave PUTs, uploads,
  moves/deletes, org-library writes, and review/admin mutations are synchronous
  request/response work, not leased jobs — so their recovery is owned by the **web
  process at its own startup**. On boot, *before it opens any mutating endpoint*, the
  web process runs a **web-owned reconciliation scan**: it selects every
  `originator='web'` operation still `prepared`/`ambiguous` and applies the same §2.4
  rules — finalize and return the stored result where the recorded precondition and
  postcondition prove the effect landed, safely retry where they prove it did not,
  otherwise mark `ambiguous`/dead-letter for the tool-specific repair path. It never
  touches worker-owned rows.
- **Before normal mutations resume:** the scan is a **boot-time safety gate**. Until it
  completes the web process is *live but not write-ready* — reads, static assets, and
  open editors keep serving, while web-originated mutating endpoints return **503
  (starting)**. "Web-originated operation recovery complete" is therefore an explicit
  web-readiness precondition (§10), mirroring how the worker withholds job claims until
  its own reclaim pass runs. The existing boot-time `markOrphanedJobsInterrupted()`
  (`db/jobs.js:135-141`) must likewise be split by originator and made lease-aware
  (§2.5) so a web restart never rewrites a live worker's in-flight jobs, or vice versa.

**Alternative considered — fail-to-manual instead of reconciliation.** The simplest
alternative to prepare → execute → reconcile is to attempt no automated reconciliation
at all: if any operation outcome is ambiguous after a crash or reclaim, **fail the job
and surface it for manual intervention.** It is rejected as the *default* because the
common cases are provably safe without a human — DB-only effects deduplicate
transactionally on the Kuhn operation id, and filesystem effects with a recorded
precondition/version fence can be finalized or safely retried — and failing every
crash-interrupted job to a person would make ordinary restarts operationally expensive
and routinely discard already-completed work. Kuhn nonetheless **keeps exactly that
fail-to-manual behavior as the fallback** for the residual cases the fences cannot
disambiguate: the `ambiguous`/dead-letter state above *is* the manual-repair path. The
protocol reconciles what is provable and stops for a human where it is not; it does
**not** claim generic exactly-once filesystem effects.

**Git history is the one effect that changes owner.** Two processes running git against
the same workspace would race the per-project commit serialization that is in-process
today (`history.js:97-103`). Commit *execution* therefore moves to the worker as a
lightweight job class: web-originated changes mark the project commit-pending
(durable), the worker coalesces and commits on the existing debounce semantics, and
terminal-job commits are emitted by the worker inline with the run. A worker outage
degrades history *granularity* (pending commits flush when it returns) without losing
any file content.

**The crash window, named.** The `move_file` sequence that motivates the protocol:
(1) the filesystem rename succeeds; (2) the process dies before the path-keyed DB
rewrite / event append / continuation checkpoint; (3) the worker lease expires;
(4) the reclaimed job cannot safely assume whether the tool operation should be
rerun. Without a prepared-operation record, neither rerunning nor skipping is safe.
With it, recovery is bounded: `applied` returns the stored result; `prepared` is
reconciled against the recorded precondition and actual state, then finalized, safely
retried, compensated, or stopped as ambiguous. The DB finalization transaction commits
the event append and continuation checkpoint metadata once. The remaining gaps are:
DB-commit-then-notification is safe because the event row is durable and the next
tail read delivers it; notification-then-projection is safe because projections are
idempotent. What the contract forbids: performing a durable mutation in one process
and its event append in another; letting both processes apply the same durable
mutation; and re-executing a mutating operation whose outcome is unknown without
reconciling first. STH-25 implements the seam and the operation store; STH-24's
replay/failure-injection work verifies these invariants at each crash boundary
(before effect · after fs effect, before DB finalize · after finalize, before wakeup
· after event append, before continuation checkpoint).

### 2.5 Leases, cancellation, suspension

- **Claim/lease:** a job row is claimed by `UPDATE … SET worker_id, lease_expires_at
  WHERE status='pending' AND lease IS NULL`-style atomic guard (the codebase already
  uses exactly this atomic-guarded-UPDATE idiom for auth tokens, invitations, and review
  links — `db/auth.js:62-70`, `db/invitations.js:105-111`). Leases are renewed on a
  heartbeat and expire so a dead worker's jobs are reclaimable.
- **Process restarts:** the existing boot-time `markOrphanedJobsInterrupted()`
  (`db/jobs.js:135-141`) becomes lease-aware — only jobs whose lease has expired are
  reclaimed, and it must be scoped so it is safe when web and worker start independently
  (today it is a blanket `UPDATE` unscoped by host — dangerous the moment two processes
  share the DB).
- **Cancellation:** persisted control state (§2.3), observed at turn boundaries and on
  lease renewal — not an ephemeral signal.
- **Resume/recovery:** continuation is Kuhn-owned and serializable per ADR 001, so
  a reclaimed job resumes from persisted state, not an opaque provider session.
- **Org/project suspension:** the same control channel; the worker checks at turn
  boundaries and on lease renewal, terminating in-flight runs — closing T-28. (Today
  only *new* dispatch and `search_org_knowledge` refuse.)
- **Operational isolation:** worker crashes don't take down request serving, and vice
  versa; each is supervised independently.

### 2.6 Worker execution model and concurrency

"One worker process" is a supervision statement, **not** a serialization claim — a
Node process runs many asynchronous jobs concurrently. The pilot execution model:

- **One worker process** with **bounded, configurable concurrency**, enforced as
  explicit slot pools per job class — agent runs and ingestion at minimum — not as an
  accident of the event loop. This ADR deliberately sets no fixed numbers (there is no
  evidence to support any); it fixes the *mechanism* (config-driven caps, measured
  under STH-26 telemetry) and STH-25 sets defaults from observed load.
- **A parked `ask_user` job does not consume an execution slot.** It retains its lease
  and durable state (question row, continuation) but releases its provider-turn slot;
  otherwise one question the user stepped away from starves every other job — the
  failure mode strict concurrency=1 creates. Active provider turns count against the
  agent-concurrency pool; parked jobs are reaped by the parked-run TTL (T-28).
- **Ingestion is bounded independently** with its own pool, replacing today's
  unbounded `setImmediate` fan-out (`ingest.js:186-188`).
- **The sandbox service enforces its own container concurrency cap and queue** (§6) —
  worker slots and container slots are separate budgets, so a render burst cannot
  starve agent turns or vice versa.
- **What runs where:** provider calls and background ingestion move to the worker —
  spend/concurrency controls (STH-19) get one home, and a 200-page PDF ingest never
  competes with request latency on the web event loop. **Interactive render/export
  does not move** — it stays a synchronous web→sandbox-service call (§6).

**Alternatives considered:** (a) keep jobs in the web process — rejected: the durability
and suspension gaps are real production risks, and heavy agent/ingest work on the request
event loop is a latency problem. (b) External queue/broker (Redis/BullMQ, SQS) —
rejected for the pilot: durable ordered events and control flags on the SQLite we
already run are sufficient at this concurrency, and adding Redis is exactly the
"distributed infrastructure for aesthetics" this ADR refuses. The seam keeps the
*option* open — moving events to a broker later is a change inside the seam, not a
product rewrite. (c) Ephemeral IPC (socket/pipe) as the primary channel — rejected:
restart correctness would then depend on both processes being up and connected;
demoted to an optional wakeup optimization (§2.3).

**Tradeoff:** two processes now share one SQLite file. SQLite supports this under WAL,
but a competing write waits synchronously and can still fail after better-sqlite3's
implicit timeout; while it waits, that process's event loop is blocked. STH-22 and
STH-25 must make the timeout explicit, keep write transactions short, and instrument
wait/failure latency. This is the leading edge of the Postgres trigger (§3).

**Supported pilot boundary:** one web process and one worker on the DB host. SQLite does
not technically prohibit a second same-host worker; Kuhn declines to support one until
load/failure testing proves contention and lease behavior remain acceptable. A worker on
a different host is incompatible with WAL/local-disk requirements and triggers Postgres.

---

## 3. Database

**Decision:** **keep SQLite** for the pilot. WAL mode, foreign keys on, accessed by the
web and worker processes on **one host**. Do **not** move to Postgres before first-team
deployment.

**Why — evaluated against the actual workload, not aesthetics:**

- **One deployment, low concurrency.** A small team generates few writes per second.
- **Yjs document updates do not write the DB.** Live document state is in-memory
  (`yjs-websocket.js` room map); durability is the editor's debounced autosave writing
  files (`routes/files.js:106-137`). Room joins and authorization/lifecycle sweeps still
  read membership or review-link state from SQLite (`collab-auth.js`; authorization
  sweeps in `yjs-websocket.js`). The high-frequency update path therefore creates low
  DB write pressure, not zero database traffic.
- **The heavy writes are transcripts, event rows, and chunks**, which are append-mostly
  and bounded by the worker's explicit per-class concurrency caps (§2.6). SQLite is
  appropriate only while write concurrency is **bounded and measured** — few writers,
  short transactions, an explicit timeout, and contention telemetry — *not* because
  "one worker process" serializes writes (it does not; a Node worker runs jobs
  concurrently).
- **Migration safety and operational simplicity.** One file, no DB service to run,
  secure, back up, patch, or tune. For a small team this is a feature, not a compromise.
- **Postgres is not automatically "more production."** It would add a service to operate,
  a network trust boundary, connection pooling, and its own backup discipline — real
  cost with no pilot benefit at this concurrency.

**If SQLite stays (it does), this ADR fixes the supported envelope:**

- **Access topology:** the supported pilot has the web process and one worker, **on the
  same host**, against one DB file. No networked filesystem and no second host. Make the
  timeout explicit and observable rather than relying on better-sqlite3's default.
- **Backup method:** the SQLite **Online Backup API** through better-sqlite3
  `db.backup()`, producing a consistent standalone destination database; never a naive
  `cp` of the live `kuhn.sqlite` alone. `VACUUM INTO` can also create a consistent copy,
  but it is a different, non-incremental procedure and is not the pilot runbook. The WAL carries uncheckpointed data
  (observed locally: 2.7 MB WAL vs 4 KB main DB); a main-file-only copy backs up
  essentially nothing (T-34). See §8.1.
- **Filesystem requirements:** a POSIX filesystem with correct `fsync`/locking — **local
  disk**, not NFS/SMB (SQLite locking over network filesystems is unreliable).
- **Schema evolution:** replace the startup-time ad-hoc DDL — a hand-maintained
  `COLUMN_MIGRATIONS` list plus `DROP TABLE`-based rebuilds that run on live data with no
  version table (`db/init.js:14-42,82-183`) — with a **versioned migration ledger** and a
  **pre-migration backup gate** (STH-22). Today `initDb` failure *starts the server
  anyway* (`index.js:116-119`); production must fail closed (STH-17).

**When Postgres becomes mandatory (any one):**

- any process that must touch the data from a **different host**;
- sustained **write contention or event-loop blocking** — recurring `SQLITE_BUSY`,
  lease churn, or unacceptable p95/p99 write latency under normal load;
- **multiple web replicas** (which SQLite cannot back across hosts);
- the org-library corpus or transcript volume outgrowing single-file practicality, or
  backup windows (§8) becoming unacceptable.

Because everything is project/tenant-scoped with an owner/tenant column from day one
(`architecture.md:156-163`), the Postgres path is `tenant_id` + row-level security, not a
rewrite — but it is a genuine migration, gated by the triggers above.

---

## 4. File storage

**Decision:** project and org-library files stay on **local durable storage**, backed up
**together with** the database. No network or object storage for the pilot.

**Why:** files are accessed only by the co-located web and worker processes through the
`storage.js` chokepoint; there is no multi-host reader to justify shared storage. Local
disk is the simplest durable option and keeps the strong containment invariants intact.

**Definitions this pins down:**

- **Directory ownership:** `KUHN_DATA_DIR` owns everything — `db/`, `files/<projectId>/`
  (each with its own `.git`), `orgs/<orgId>/library/`, and transient `files/.render-tmp/`
  (`config.js:6-7,22,69,111`, `data-pipeline.md:38-43`). Owned by the service user; the
  worker needs the same read/write access as the web process.
- **Backup relationship to SQLite:** files and DB must be captured as **one consistent
  snapshot** (§8). Org-library originals are **not reconstructible from the DB** (only
  sha256 + chunks persist — `schema.sql:290-315`), so excluding `orgs/` silently loses
  source documents. Per-project `.git` lives *inside* the workspace — a "user content
  only" filter that skips dotdirs silently drops all version history.
- **Atomicity expectations:** writes go through `storage.js` (contained, symlink-proof);
  history commits are serialized per project (`history.js:97-103`). There is no
  cross-file transactionality between the DB and the filesystem — the backup consistency
  model (§8) is how we bound the resulting skew.
- **Network/object storage:** **not required now** and not adopted. It would solve
  multi-host access and elastic capacity — neither a pilot need — at the cost of a new
  egress boundary, a new credential, and losing local `.git`/`realpath` containment
  semantics.

**Scale trigger:** multiple web/worker hosts needing shared file access, or capacity
beyond a single volume, triggers network/object storage — the same multi-host threshold
as the Postgres trigger, and the two will likely move together.

---

## 5. Collaboration / Yjs

**Decision:** Yjs room state stays **single-instance and in-memory**; durability comes
from autosave to storage. No external Yjs coordination (no Redis, no y-sweet/hocuspocus
cluster) for the pilot.

**Why:** rooms are `Map`-held per process (`yjs-websocket.js:86`), seeded from storage on
first open and reseeded after restart (`editor-core.ts:417-468`); a crash loses only
not-yet-autosaved keystrokes (`data-pipeline.md:112-118`). With a single web instance
this is correct and cheap. External coordination exists only to share room state *across
instances* — which the pilot does not have.

**Pilot expectations, made explicit:**

- **Single-instance ownership:** exactly one web process terminates all doc-sync
  WebSockets; room identity is process-local.
- **Restart behavior:** all rooms vanish on restart; the next opener re-seeds from
  storage bytes. Un-autosaved keystrokes since the last debounced save are lost — the
  accepted durability boundary.
- **Persistence/reseed:** no Yjs persistence layer; storage is the source of truth. The
  server designates one write-capable connection per empty room as seeder
  (`yjs-websocket.js:696-711`).
- **Why no external coordination:** it buys cross-instance room sharing, which requires
  multi-instance web — explicitly out of pilot scope (§1).
- **Graceful shutdown gap:** there is no SIGTERM handler today, so a deploy drops rooms
  and abandons up-to-120 s of coalesced git commits (`unref`'d timers, `history.js:142`).
  STH-27 must add draining + a commit flush on shutdown.

**Trigger for Redis/shared coordination:** the first time a second web instance
terminates WebSockets. At that point rooms must move to a shared coordinator (Redis
pub/sub or a dedicated Yjs backend) *and* the SSE/live-run registries must externalize
too. This is the same multi-instance threshold as §1/§3 — deferred as one step.

---

## 6. Sandbox boundary

**This is the most important security decision in the ADR.** Today the public Node
web/API process invokes Docker directly (`spawn('docker', …)`, `sandbox.js:56`).
**Docker control is effectively host-root**: a compromise of the web process (e.g. via a
dependency RCE) collapses the sandbox boundary and yields host takeover (threat model
T-25, the one Critical topology finding).

**Decision:** the web process **loses direct Docker access**. Sandbox execution moves
behind a **dedicated local sandbox worker/service** with a **deliberately narrow
invocation surface** — the simplest robust isolation that removes host-root-equivalent
control from the internet-facing process. **No orchestration system** (no Kubernetes, no
Nomad). This is the boundary STH-21 implements.

**The narrow surface:** the sandbox service accepts only a small, enumerated set of
render/ingest operation types. A request carries the **operation type, logical
project/org/document identifiers as appropriate, workspace-relative paths, and
bounded operation-specific options** — never an absolute host path, a mount
specification, an image name, Docker argv, or an arbitrary command. The web/worker
processes call it over an authenticated **local-only** channel (prefer a Unix domain
socket with restrictive ownership and peer-credential checks; loopback requires mutual
authentication), and it is the *only* component with Docker access. The existing argument validation is
already shaped for this: Pandoc extra-args are allowlisted by regex and documented as
never-user-input (`sandbox.js:158-166`); the render service composes fixed arguments
(`render.js:45-49`). STH-21 formalizes that into the service's request schema.

**Containment is enforced by the service, independently of its caller.** Nothing the
caller sends chooses a host mount, image, or Docker command. The service resolves
logical identifiers, validates paths beneath configured Kuhn roots, and stages input
into a service-owned directory using no-follow/file-descriptor-safe operations before
mounting that staging directory read-only. Canonicalize-then-mount alone is insufficient:
a caller that can mutate the source tree could swap a symlink between those steps. The
service constructs every mount and command, owns writable scratch/output directories,
and selects digest-pinned images.

This boundary has a precise limit. It removes **arbitrary Docker control and arbitrary
host-filesystem mounts** from a compromised web/worker process; it does not preserve
tenant confidentiality after that process is compromised. The web process still has its
normal tenant-file authority, and the worker has job-file authority. Normal member/guest
authorization therefore remains the caller's responsibility; the sandbox service
validates operation/resource shape and method permissions, not end-user membership.

**Interactive render/export stays synchronous.** `POST /api/projects/:id/render` and
`GET /api/projects/:id/export` return PDF/export bytes in the response today
(`routes/render.js:52,68`), and this ADR deliberately preserves that product
semantic — they are **not** converted into background jobs. The web process makes a
**bounded synchronous request/reply call to the sandbox service** over the narrow
local RPC and streams the result back to the caller; the web process itself still has
no Docker access, and the service's concurrency cap/queue and resource limits protect
the host from render bursts (T-22). If the sandbox service is down or saturated, the
render/export endpoints return a clear **503/degraded** response — the editor and the
rest of the app stay available (§10). Routing interactive render through the job
worker was considered and rejected: it would add a request/reply RPC hop through the
worker for no isolation gain (the worker has no Docker access either), and couple
editor-facing latency to the job queue. **Background ingestion** extraction, by
contrast, is naturally asynchronous and is invoked by the worker through the same
sandbox service.

**Specification for STH-21:**

- **Trust boundary:** only the sandbox service talks to the Docker daemon; the
  web/API process does not have Docker socket access. A web-process RCE can *request* a
  render, not run arbitrary containers.
- **Caller authentication and method authorization:** prefer a Unix socket owned by a
  dedicated group; validate peer credentials and give web and worker separate service
  identities/method allowlists (web: render/export; worker: ingestion). If loopback is
  used, mutual authentication and replay-resistant request credentials are mandatory;
  an unauthenticated local HTTP port is not a boundary.
- **Caller-independent request surface:** requests are enumerated operation types
  with logical resource identifiers, workspace-relative paths, and bounded options
  only. The service rejects absolute host paths, `..` traversal, and symlink
  escapes. Resolve/stage with no-follow semantics into service-owned paths so a
  symlink/rename race cannot change what Docker mounts. The service alone constructs
  mounts, chooses images, and composes commands.
- **Service identity:** run the sandbox service under a **distinct OS/service identity**
  with Docker control confined to that identity — the web/worker service users hold no
  Docker group membership or socket access. Docker access is still host-privileged, so
  this identity is isolated, narrowly reachable, and treated as a high-value service.
- **Filesystem mounts:** project mounted **read-only** at `/work`; a single writable
  scratch out-dir at `/out`; nothing else (as today, `sandbox.js:30-31`). Ingestion
  already narrows the mount to one document's directory (`ingest.js:41-43`) — keep that.
- **Network policy:** `--network none` (unchanged, `sandbox.js:26`).
- **Image pinning:** pin the three images by **digest**, not `:latest`
  (`config.js:152-155` today) — supply-chain integrity for code that parses untrusted
  documents (T-26).
- **Resource limits:** keep cpu/memory/pids caps and the 60 s kill; **add** `--ulimit
  fsize` so a renderer cannot fill the host disk through `/out`, and enforce a
  bounded input/output/stream size, request deadline, **concurrency cap / finite queue**,
  and per-caller quotas on sandbox jobs (today ingestion fans out via bare
  `setImmediate` with no limit — `ingest.js:186-188`; render is viewer-triggerable —
  `routes/render.js:52`; T-22).
- **Privilege expectations:** add `--user` (non-root in-container), `--read-only` root
  fs with a `--tmpfs /tmp`, `--cap-drop=ALL`, and `--security-opt=no-new-privileges` —
  all absent today (T-24).
- **Scratch/output lifecycle:** use unique service-owned directories, cap their size,
  reject unexpected output names/types, and remove them on success, failure, timeout,
  and startup recovery.
- **Credentials/data visibility:** the container receives **no credential environment**
  today (no `-e`/`--env-file` in `buildDockerArgs`) — preserve this. The host-side Docker
  CLI currently inherits the parent process environment; the new service should pass a
  minimal explicit environment to all child processes. Each container sees only its
  staged input and bounded parameters, never `.env` or the DB.

**Alternatives considered:** (a) keep direct Docker with only flag hardening — rejected:
flag hardening (T-24) is necessary but does not remove host-root-equivalent control from
the internet-facing process (T-25). (b) A full orchestrator or per-tenant VM isolation —
rejected for the pilot: disproportionate operational weight; a local sandbox service with
a narrow surface removes direct Docker control from the web process without claiming
full containment of a compromised application process.
(c) gVisor/Kata/rootless-Docker as the runtime under the service — **compatible** with
this decision and worth evaluating inside STH-21, but orthogonal to moving the boundary.

---

## 7. Reverse proxy and TLS

**Decision:** a reverse proxy in front is **required** in production; the app has no TLS
of its own. Vendor-neutral (Cloudflare Tunnel and nginx both work — `deployment.md:97-116`).

Requirements:

- **TLS termination** at the proxy; HTTPS only. The session/reviewer cookie `secure`
  flag is derived from `KUHN_APP_URL` (`routes/auth.js:29-31`), so **`KUHN_APP_URL` must
  be the real https origin** or cookies ship non-Secure (T-02) — STH-17 validates this
  at boot.
- **Canonical public origin for credential URLs:** today magic-link/invite/review URLs
  are built from `req.protocol` + `req.get('host')` (`routes/auth.js:48`,
  `routes/orgs.js:109`, `routes/review-links.js:80`) with `app.set('trust proxy',
  true)` trusting *all* hops (`index.js:38`) — a **host-header injection →
  credential-exfiltration** path if the origin is directly reachable or the proxy
  forwards client `X-Forwarded-*` (T-27). The production fix is not primarily proxy
  discipline: **credential-bearing URLs are generated from the validated, configured
  canonical public origin — `KUHN_APP_URL` — never from request protocol/Host.** The
  supported pilot is same-origin, so that URL is both the application and public API
  origin. That
  removes Host-header choice from the credential-minting path entirely, instead of
  making proxy correctness the security root. (STH-17 validates `KUHN_APP_URL` as a
  real https origin at boot.) The current split-origin recipe is outside this production
  baseline. Supporting it safely later requires a separately validated public API origin
  for verification/review URLs plus explicit cookie/CORS tests; do not silently reuse the
  webapp redirect origin for API credential URLs.
- **Proxy identity & trusted headers (defense-in-depth):** still **bound `trust proxy`
  to the known proxy** (hop count or subnet) for request metadata that genuinely needs
  proxy awareness (client IP for rate limiting/audit, scheme for redirects and logs);
  ensure the proxy **sets** `X-Forwarded-Proto`/`Host` and **strips** client-supplied
  forwarding headers; and **block direct origin reachability**. (STH-17.)
- **WebSocket & SSE support:** the proxy must forward WS upgrades (Yjs) and not buffer SSE
  (`X-Accel-Buffering: no` is already set — `routes/sse.js`); the job-scoped agent stream
  has **no heartbeat**, so proxy idle timeouts must accommodate long turns or STH-26/STH-27
  must add one.
- **Upload/body limits:** JSON body is 100 KB (`express.json()`, `index.js:42`); raw file
  bodies and uploads are capped at 20 MB × 20 (`config.js:107`, `routes/uploads.js:14-18`).
  The proxy should enforce a matching max body size so oversize requests die at the edge.
- **Timeouts:** proxy read/write timeouts must exceed legitimate long-lived streams
  (agent runs, large renders) but bound truly stuck connections.
- **Production `trust proxy` policy:** as above — a specific, bounded setting, never
  blanket-trust, and never with the origin exposed.

**Not hard-coded to one vendor.** Cloudflare Tunnel is the documented example
(`deployment.md:97-116`); any proxy meeting the above is acceptable.

---

## 8. Backup and restore ownership

**Decision:** recovery is split into **two coordinated domains** — an encrypted **data
backup** and a separately protected **secret escrow** — plus the **versioned
application artifact** (§9). "One recoverable Kuhn deployment" = data backup + the
matching application artifact + secrets re-bound from escrow or reissued. This is the
contract STH-23 implements. (An earlier draft of this section both put `.env` inside
the recoverable snapshot *and* required secrets isolated from the data — a
contradiction, now resolved as §8.3.)

### 8.1 The supported backup method (one, chosen)

The pilot's supported DB backup method is the **SQLite Online Backup API** through
better-sqlite3 `db.backup()`. It produces a consistent, standalone destination database
while the source remains open, and it can advance incrementally. For Kuhn's composite
DB+filesystem snapshot, the maintenance barrier in §8.5 prevents concurrent web/worker
writes and avoids backup restart/starvation from a second connection.

The destination is a *single complete database*; the live `kuhn.sqlite` / `-wal` /
`-shm` files are not captured raw, and "online backup" does not mean "hot-copy all
three SQLite files." A naive `cp kuhn.sqlite` alone remains forbidden because the WAL
may contain committed pages not yet checkpointed (T-34).

`VACUUM INTO` is an SQLite-supported alternative that creates a compact, logically
equivalent database copy, purges free/deleted pages, uses more CPU, and is not
incremental. It is not interchangeable with `db.backup()` in the Kuhn runbook. A future
operator may adopt it only as a separately specified and restore-tested procedure.

**Raw filesystem snapshotting is a different method, not the supported pilot path.**
If a deployment uses volume/filesystem snapshots anyway, that procedure has its own
rules — quiesce writers, checkpoint the WAL, and snapshot main+WAL+SHM atomically on
one filesystem — and must be documented as a separate method. It is not what this
contract means by "DB backup."

### 8.2 What the data backup contains

1. **Database** — the online-backup **destination** file (§8.1), staged then encrypted.
2. **Project files** — `data/files/` **including every per-project `.git`** (history
   lives inside the workspace; a "user content only" filter silently drops it).
3. **Org library** — `data/orgs/` originals (**not** reconstructible from the DB —
   only sha256 + chunks persist, `schema.sql:290-315`).
4. **Mutable deployment metadata** — the recorded **application version/commit and
   schema/migration version**, so restore selects the matching artifact (§9) and
   STH-22's ledger can verify compatibility (restoring a DB under an older binary is
   undefined).

**Deliberately not in the data backup:** secret material (§8.3) and `guidance-docs/`
(§8.4). Backups are **encrypted, access-controlled, tenant-isolation-preserving** (a
restore reproduces the same per-tenant boundaries), and restore is **drill-tested**
(STH-23 acceptance), not assumed.

### 8.3 Secret recovery is a separate domain

The data backup never contains secret material; the ciphertext and the key that
protects it never share a security domain (T-32). Two secret classes:

- **Escrowed (must survive loss of the host):** `KUHN_SESSION_SECRET`; a future
  encryption/master key, if one is introduced, is *truly* restore-critical and lives
  only here; the SMTP credential if it cannot simply be reissued.
- **Reissued/rotated at recovery (preferred wherever possible):** provider API
  credentials — `ANTHROPIC_API_KEY` today, org BYOK secrets later — are re-entered or
  rotated during restore rather than archived forever. The DB (and therefore the data
  backup) stores credential *references* only; restore re-binds them to secrets from
  escrow or reissue.

**Restore semantics when a secret is unavailable, stated in the runbook:** losing
`KUHN_SESSION_SECRET` invalidates every session — users log in again; acceptable, and
sometimes even desirable after an incident. A missing provider credential pauses agent
execution until re-entered/rotated — acceptable. A lost future master key would be
unrecoverable data — which is exactly why it is escrowed under independent protection
rather than living beside the data it protects.

### 8.4 `guidance-docs/` is application content, not tenant data

`guidance-docs/` is immutable Kuhn-shipped product content. It **ships inside the
versioned application artifact** (§9); the data backup records the application version
(§8.2 item 4); restore obtains the catalog by restoring the matching artifact. It is
*not* backed up as mutable tenant data. (Today a deploy missing it silently degrades
the catalog — `db/seed.js:112-115`. The §9 artifact build must fail when the catalog is
absent, and restore verification must check that the recorded image contains it.) If a deployment ever intentionally
overrides `guidance-docs/` at runtime, that override becomes explicit configuration
and is backed up as configuration — no silent middle ground.

### 8.5 Consistency: the maintenance write barrier — and what the backup guarantees

**The guarantee, stated first: the backup captures the last durably persisted Kuhn
state** — everything that has reached the database or the file store. Kuhn's
Markdown durability is **client-driven**: the browser schedules a debounced
`writeFile()` when the editor changes (`editor-core.ts`); the server has no
mechanism to make connected clients flush, and this contract does not pretend one
exists. **In-memory Yjs/client keystrokes that have not yet autosaved are outside
the backup guarantee — exactly as they are outside crash durability today (§5).**
The backup never claims state that has never reached durable storage.

Pausing only the worker is **not enough** for a consistent DB + filesystem capture:
the web process also mutates state — project files through editor autosave PUTs and
uploads, org-library files, review/admin DB state. The snapshot therefore runs under
a brief **maintenance write barrier**:

1. Stop new worker job claims; bring active jobs to a checkpoint or requeue
   boundary (bounded wait — the continuation seam in §2.3 is what makes this cheap).
2. Enter maintenance mode.
3. Drain already-in-flight mutating HTTP requests (bounded).
4. Freeze new mutating HTTP requests and Yjs/WS-originated writes. Reads and open
   editors may stay up, but a save that reaches today's client during a 503 is **not**
   automatically retried (`editor-core.ts` save engine). Until STH-23 adds explicit
   maintenance/read-only UI or retry semantics, the backup procedure must surface the
   unsaved state and must not describe the write as harmlessly deferred. Those bytes
   remain outside this backup until a later successful save.
5. Flush durable pending git-history work (the worker's commit-pending queue, §2.4).
6. Run the online backup (§8.1) to a staging destination.
7. Capture `data/files/` and `data/orgs/` while the barrier holds.
8. Record application/schema version (§8.2 item 4).
9. Release the barrier.

At pilot scale the barrier window is seconds. There is still no cross-store
transaction — the barrier bounds DB↔filesystem skew for *persisted* state to
effectively zero for the capture; it does not (and cannot) pull unpersisted editor
state into the snapshot.

**Alternative considered and deferred — a pre-barrier client flush handshake:**
announce pending maintenance to connected editors; clients flush their current
Markdown while writes are still allowed; clients ACK; after all ACKs or a bounded
timeout, the strict barrier begins. That would narrow the boundary to "every
visible client edit at barrier time," at the cost of a new client/server protocol
plus timeout semantics for absent clients. The pilot deliberately does not build
it: the backup durability boundary is kept **identical to the crash-durability
boundary users already live with**. STH-23 records this as the trigger — build the
handshake only if the product later requires keystroke-complete snapshots.

**Scale trigger:** when the barrier window / backup window exceeds tolerance, move to
incremental/streaming backup (WAL archiving for SQLite, or Postgres PITR after the DB
migration).

### 8.6 Restore order and acceptance

Restore is a staged replacement, not an in-place overwrite of a running deployment:

1. Isolate the target and keep web/worker stopped. Verify backup authenticity, decrypt
   into service-owned staging, and select the exact recorded application/schema version.
2. Restore the standalone DB destination, project files (including `.git`), and org
   originals into an empty staging data root with restrictive ownership. Re-bind
   reissued provider credentials and the separately escrowed session/master secrets.
3. Before any upgrade migration, boot the matching recorded artifact in verification
   mode and run SQLite integrity/foreign-key checks, file/catalog presence checks, and
   tenant-isolation smoke tests. Preserve the restored backup before STH-22 advances its
   migration ledger; never open a newer DB with an older binary.
4. Promote the staged data root atomically or during a documented maintenance window.
   Start the web with the worker paused, verify readiness and representative tenant/file
   access, then enable worker claims and verify one sandbox and one provider path.

A restore is successful only after these checks and a recorded drill result. A missing
artifact version, secret, original file, or incompatible schema stops the restore rather
than starting a partially recovered service (STH-22/STH-23/STH-27/STH-29).

---

## 9. Deployment artifact

**Decision:** package the server components (backend + built webapp + the
`guidance-docs/` catalog content, per §8.4) as an **immutable container image**, with
the three sandbox images **pinned by digest**. Replace the current
`git pull && npm install && npm run build` upgrade (`deployment.md:184-193`) with a
versioned artifact and a documented rollback.

**Why:** reproducibility and rollback. The current flow builds on the production host,
pins nothing, and has no rollback path; a bad `npm install` or a mid-build failure leaves
an indeterminate state. An immutable image pins the Node runtime and both packages, makes
"which version is running" answerable, and makes rollback "run the previous tag."

**Alternatives considered:** (a) system service + pinned Node build (systemd + a tarball) —
viable and lighter, and acceptable if containerizing the server proves awkward, but it
doesn't pin the runtime as cleanly and rollback is more manual. (b) Status quo — rejected:
no reproducibility, no rollback (T-33).

**Nuance — this does *not* mean "containerize everything now."** The web and worker
processes as an image is the recommendation; the **sandbox** already uses containers
(that's the isolation boundary, §6). Running the whole app in an image is a packaging
choice for STH-29, not a mandate to move persistence or collaboration into containers —
the DB and files stay on host-mounted durable storage regardless.

**What STH-29 owns (not implemented here):** the image build, digest pinning, the
upgrade/rollback runbook, migration preflight ordering (image up → migration gate →
readiness), and how the DB/file volumes and `.env` are mounted into the container.

---

## 10. Observability and health boundaries

**Decision:** health is **component-specific**. Defining global readiness as "every
subsystem is healthy" would turn partial degradation into full outage — the scientific
editor, collaboration, and read experience must not disappear because agent execution
or rendering is temporarily unavailable. Targets for STH-26/STH-27; not implemented here.

- **Web process.** *Liveness:* the process/event loop is alive — nothing more.
  *Readiness* requires what the core web/API needs to serve safely: **valid production
  configuration** (STH-17), **DB reachable at the expected migration version**,
  **required persistent storage usable**, **static application assets present**, and
  the **web-originated operation recovery scan complete** (§2.4) — until it finishes,
  the process is live but web-originated mutating endpoints return 503. The web
  **remains ready** while the model provider, the worker, or the sandbox
  service is unavailable: those states surface as **degraded subsystem health**
  (visible in health detail and metrics), and the affected endpoints — agent dispatch,
  render/export — return **503** while the editor/collaboration/read experience keeps
  serving.
- **Worker process.** *Readiness:* DB/schema at the expected version; the
  lease/control-plane tables (§2.3) accessible; required runtime configuration and
  secrets present. **Transient provider reachability is not a readiness gate** — a
  provider outage is an operational/degraded state handled through retries,
  circuit-breaking, and telemetry, not a reason for a supervisor or load balancer to
  repeatedly restart or withdraw an otherwise-healthy worker (that only adds flapping
  to an upstream outage).
- **Sandbox service.** Its **own** health/readiness: Docker daemon/runtime accessible;
  the required digest-pinned images available; its queue not irrecoverably broken.
  Web and worker treat sandbox unhealthiness as degraded rendering/ingestion (503 on
  those endpoints), never as their own unreadiness.
- **Today's `/health`** is unauthenticated (correct) but reports only `db: SELECT 1` +
  uptime (`routes/health.js:6-14`) and leaks `db.error` (T-36) — trim the leak.
- **Structured logs:** JSON to stdout (collected by the platform), **with secrets and
  content redacted** — closing the raw-token-to-stdout hazard (T-08) is a log-hygiene
  requirement, not just an SMTP one.
- **Correlation:** request id, safe internal user id, org, project, job, worker, and
  provider-profile ids threaded across HTTP, WS, jobs, and provider calls (STH-26).
- **Shutdown/draining:** SIGTERM must drain connections, stop claiming new jobs, let
  in-flight turns reach a checkpoint or re-queue, **flush pending git commits**, and close
  the DB — none of which exists today (no signal handler; `unref`'d commit timers lost).
  (STH-27, STH-25.)

---

## 11. Scale ceiling

**What this reference topology is explicitly *not* designed for**, with the qualitative
triggers that force the next architecture step (precise numbers would be fabricated at
this stage; these are the real signals):

- **Multiple web replicas / HA.** Single web instance is a single point of failure and the
  sole owner of in-memory Yjs rooms and SSE/run registries. Trigger: an availability
  requirement (no SPOF) or CPU-bound request serving. Forces: externalized Yjs
  coordination (§5), externalized registries, a load balancer (§7), and Postgres (§3).
- **Write contention.** SQLite is single-writer; the web+worker pair is the supported
  limit. Trigger: recurring `SQLITE_BUSY` / lease churn under normal load. Forces:
  Postgres.
- **Worker concurrency.** One worker is the chosen supported pilot limit, not a SQLite
  law. Trigger: agent/ingest backlog a single worker cannot clear. Before adding another,
  use STH-30 load/failure evidence to decide whether same-host SQLite contention remains
  acceptable; otherwise move to Postgres and possibly a real queue.
- **Backup windows.** A full consistent snapshot requires a brief maintenance write
  barrier (§8.5). Trigger: data volume makes that window unacceptable. Forces:
  incremental/streaming backup (§8).
- **Storage capacity.** One local volume. Trigger: files/org-library outgrow it. Forces:
  network/object storage (§4).
- **Cross-region / multi-host.** Not supported: SQLite and local files are single-host by
  construction. Trigger: any second host that must touch the data. Forces: Postgres +
  shared/object storage together.
- **Tenant/user scale.** The pilot is one org or a few, low tens of users. A defensible
  estimate of the ceiling is **when concurrent agent/ingest load saturates one worker or
  when write rate produces sustained `SQLITE_BUSY`** — both worker/DB signals above,
  reached well before any raw user-count limit. We deliberately avoid a fake user-count
  number; the operative limits are write contention and worker saturation.

None of these triggers is met by the first-team pilot. The design pays for exactly what
that pilot needs — durable jobs, an isolated sandbox, recoverable data, a bounded proxy —
and builds the seam (Kuhn-owned continuation, tenant-scoped rows, a narrow sandbox surface)
so the multi-instance step later is an addition, not a rewrite.

## Consequences

- **Downstream issues get concrete direction** without re-deciding topology: STH-25
  (worker + leases + the durable event/control seam and mutating-operation store of
  §2.3–2.4), STH-24 (the replay/idempotency, operation-recovery, and audit
  invariants of §2.4), STH-21 (sandbox service with caller-independent containment
  + hardening + synchronous render RPC), STH-22 (migration ledger + `busy_timeout` +
  fail-closed init), STH-23 (two-domain recovery + write barrier), STH-17 (boot-time
  config validation incl. canonical-origin URL generation/`KUHN_APP_URL`/`trust
  proxy`/SMTP), STH-27 (component-specific readiness/shutdown), STH-29 (immutable
  artifact incl. `guidance-docs/`), STH-26 (correlated logs/metrics).
- **The pilot keeps SQLite and local files** because the workload — one deployment, low
  concurrency, Yjs off the DB, bounded-and-measured worker write concurrency — makes
  them technically sound, not merely convenient.
- **The two genuinely unsafe co-residencies are separated:** durable background execution
  (STH-25) and host-privileged Docker control (STH-21). Everything else stays simple.
- **Multi-instance is deferred as one coherent step** (Yjs + registries + Postgres + LB),
  behind explicit triggers, rather than partially and prematurely.
- **This ADR does not implement anything.** It is the reference the milestone-3/4 issues
  build to; where an issue's local instinct contradicts it (e.g. "add Redis," "go Postgres
  now," "keep Docker in the web process"), this ADR is the tie-breaker.

## References

- [ADR 001 — provider-agnostic runtime foundation](001-provider-agnostic-runtime-foundation.md): landed on `main` (merged in [PR #69](https://github.com/soundtrip-health/kuhn/pull/69))
- [Threat model & data classification](../security/threat-model.md) (STH-2)
- [architecture.md](../architecture.md), [deployment.md](../deployment.md), [data-pipeline.md](../data-pipeline.md)
