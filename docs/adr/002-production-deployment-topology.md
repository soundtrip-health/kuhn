# ADR 002: Production deployment topology and scale boundary

- **Status:** Accepted for the first-team pilot
- **Date:** 2026-08-16
- **Issues:** PLA-225 (this ADR); informs PLA-236, PLA-240, PLA-241, PLA-242,
  PLA-244, PLA-245, PLA-246, PLA-248
- **Companion:** [threat-model.md](../security/threat-model.md) (PLA-224) — the
  security model and this topology constrain each other and were written as one pass.
- **Relationship to ADR 001:** ADR 001 (provider-neutral runtime) is **pending in
  [PR #69](https://github.com/soundtrip-health/kuhn/pull/69)**, not yet on `main`; it
  lands at `docs/adr/001-provider-agnostic-runtime-foundation.md` when #69 merges. This
  ADR references its accepted direction (a narrow `AgentRuntime` seam beneath
  `runAgentTask`) but does not depend on its implementation details.

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
   loop on every query (`db.js:63-65`); there is no `busy_timeout` (`db.js:14-21`), so a
   second writer throws `SQLITE_BUSY` rather than waiting. This is the concrete ceiling
   the scale triggers key off.

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
| Background jobs | **Split into a dedicated worker process** on the same host, sharing the DB and files, with DB-backed leases | Worker CPU saturation; need for multiple workers |
| Database | **Keep SQLite** (WAL, single writer), accessed by web + worker on one host | Sustained write contention / `SQLITE_BUSY`; need for a second host to touch data → **Postgres** |
| File storage | **Local durable disk**, backed up with the DB | Multi-host access to files; capacity beyond one volume → network/object storage |
| Collaboration (Yjs) | **Single-instance in-memory rooms**, durability via autosave | Any second web instance that terminates WebSockets |
| Sandbox | **Dedicated local sandbox worker/service** with a narrow invocation surface; web process loses direct Docker access | — (this is itself the hardening; larger isolation only if multi-host) |
| Reverse proxy / TLS | **Required**; bounded `trust proxy`; WS/SSE forwarding; body/timeout limits | Multi-instance → real load balancer |
| Backup/restore | **One consistent snapshot** of DB(hot)+files+orgs+`.env`+guidance, versioned | Backup window exceeds tolerance → incremental/streaming |
| Deployment artifact | **Immutable container image** for the server components + pinned sandbox images | — |
| Observability | Structured logs + readiness/liveness that fail when persistence/worker/sandbox are unhealthy | — |

The through-line: **keep request-serving simple and single-instance; separate the two
things that are genuinely unsafe or unreliable co-resident — durable background
execution (PLA-244) and host-privileged Docker control (PLA-240); make persistence
recoverable (PLA-241/242); and build the *seam* for multi-instance later rather than
paying its cost now.**

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
  (`jobs.js:135-141`) and loses in-flight work. → dedicated worker, §2.
- **Docker control** — direct `docker` CLI invocation makes the web process host-root
  equivalent (`sandbox.js:56`). → sandbox worker, §6.

**Scale trigger:** move to multiple web replicas only when a single instance is
CPU-bound on request serving *or* availability requires no-single-point-of-failure. That
step **requires** externalizing Yjs coordination (§5) and the SSE/run registries, and
almost certainly Postgres (§3) — it is a topology change, not a config flag, and this
ADR deliberately defers it.

---

## 2. Background jobs

**Decision:** move agent/background execution into a **dedicated worker process** on the
**same host**, sharing the same SQLite database and the same file volume, coordinating
through **DB-backed job leases**. Not a separate service tier, not a message broker — a
second Node process supervised alongside the web process.

**Why:** durable execution is the one part of the runtime that is unsafe co-resident with
request serving. Today a deploy/restart or a crash loses in-flight runs, parked
`ask_user` runs live forever with unbounded event buffers (`config.js:87-90`,
`runtime.js:179-184`), and org suspension doesn't stop a running job
(`runtime.js:1029-1033`). A worker with an explicit lifecycle fixes all three without a
broker.

**This gives PLA-244 its topology** without re-deciding everything:

- **Claim/lease:** a job row is claimed by `UPDATE … SET worker_id, lease_expires_at
  WHERE status='pending' AND lease IS NULL`-style atomic guard (the codebase already
  uses exactly this atomic-guarded-UPDATE idiom for auth tokens, invitations, and review
  links — `db/auth.js:62-70`, `db/invitations.js:105-111`). Leases are renewed on a
  heartbeat and expire so a dead worker's jobs are reclaimable.
- **Process restarts:** the existing boot-time `markOrphanedJobsInterrupted()`
  (`jobs.js:135-141`) becomes lease-aware — only jobs whose lease has expired are
  reclaimed, and it must be scoped so it is safe when web and worker start independently
  (today it is a blanket `UPDATE` unscoped by host — dangerous the moment two processes
  share the DB).
- **Cancellation:** client disconnect / job cancel must reach the worker. With a shared
  DB, a `cancel_requested` flag the worker polls (or a lightweight local IPC) is
  sufficient at pilot scale; no broker.
- **Resume/recovery:** continuation is Kuhn-owned and serializable per ADR 001 (#69), so
  a reclaimed job resumes from persisted state, not an opaque provider session.
- **Org suspension:** the worker checks suspension at turn boundaries and on lease
  renewal, terminating in-flight runs — closing T-28. (Today only *new* dispatch and
  `search_org_knowledge` refuse.)
- **Provider calls, ingestion, render jobs:** all move to the worker, so a burst of agent
  turns or a 200-page PDF ingest never competes with request latency on the web event
  loop. This also gives spend/concurrency controls (PLA-238) one place to live.
- **Operational isolation:** worker crashes don't take down request serving, and vice
  versa; each is supervised independently.

**Alternatives considered:** (a) keep jobs in the web process — rejected: the durability
and suspension gaps are real production risks, and heavy agent/ingest work on the request
event loop is a latency problem. (b) External queue (Redis/BullMQ, SQS) — rejected for
the pilot: a DB-backed lease on the SQLite we already run is sufficient for a handful of
concurrent jobs, and adding Redis is exactly the "distributed infrastructure for
aesthetics" this ADR refuses. The lease design keeps the *option* open — moving to a
broker later is a worker-internal change.

**Tradeoff:** two processes now share one SQLite file. SQLite handles multi-process
access under WAL, but **without `busy_timeout` a writer collision throws immediately**
(`db.js:14-21`); PLA-241/244 must set a `busy_timeout` and keep write transactions short.
This is the first place the single-writer property bites, and it is the leading edge of
the Postgres trigger (§3).

**Scale trigger:** multiple workers, or a worker on a *different host* from the DB, forces
Postgres (§3) — SQLite is single-host by construction.

---

## 3. Database

**Decision:** **keep SQLite** for the pilot. WAL mode, foreign keys on, accessed by the
web and worker processes on **one host**. Do **not** move to Postgres before first-team
deployment.

**Why — evaluated against the actual workload, not aesthetics:**

- **One deployment, low concurrency.** A small team generates few writes per second.
- **Yjs traffic never touches the DB.** Live collaboration is in-memory
  (`yjs-websocket.js:8-10`); durability is the editor's debounced autosave writing files
  (`routes/files.js:106-137`), not DB writes. The high-frequency collaboration path
  therefore does not load the database at all — a key reason SQLite is sufficient.
- **The heavy writes are transcripts and chunks**, which are append-mostly and bounded by
  agent/ingest concurrency, which the worker (§2) serializes anyway.
- **Migration safety and operational simplicity.** One file, no DB service to run,
  secure, back up, patch, or tune. For a small team this is a feature, not a compromise.
- **Postgres is not automatically "more production."** It would add a service to operate,
  a network trust boundary, connection pooling, and its own backup discipline — real
  cost with no pilot benefit at this concurrency.

**If SQLite stays (it does), this ADR fixes the supported envelope:**

- **Access topology:** at most the web process and one worker, **on the same host**,
  against one DB file. No third writer, no networked filesystem for the DB, no second
  host. Set **`busy_timeout`** (PLA-241) so brief contention waits instead of throwing.
- **Backup method:** a **hot** backup — `sqlite3 .backup` / `VACUUM INTO` /
  better-sqlite3 `db.backup()` — never a naive `cp` of `kuhn.sqlite` alone. The WAL
  carries uncheckpointed data (observed locally: 2.7 MB WAL vs 4 KB main DB); a
  main-file-only copy backs up essentially nothing (T-34). See §8.
- **Filesystem requirements:** a POSIX filesystem with correct `fsync`/locking — **local
  disk**, not NFS/SMB (SQLite locking over network filesystems is unreliable).
- **Schema evolution:** replace the startup-time ad-hoc DDL — a hand-maintained
  `COLUMN_MIGRATIONS` list plus `DROP TABLE`-based rebuilds that run on live data with no
  version table (`db/init.js:14-42,82-183`) — with a **versioned migration ledger** and a
  **pre-migration backup gate** (PLA-241). Today `initDb` failure *starts the server
  anyway* (`index.js:116-119`); production must fail closed (PLA-236).

**When Postgres becomes mandatory (any one):**

- a **second worker**, or any process that must touch the data from a **different host**;
- sustained **write contention** — recurring `SQLITE_BUSY`/lease churn under normal load;
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
  PLA-246 must add draining + a commit flush on shutdown.

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
Nomad). This is the boundary PLA-240 implements.

**The narrow surface:** the sandbox service accepts only a small, enumerated set of
render/ingest job kinds with typed parameters — never an arbitrary `docker run` command
line. The web/worker processes call it over a **local-only** channel (Unix domain socket
or loopback), and it is the *only* component with Docker access. The existing argument
validation is already shaped for this: Pandoc extra-args are allowlisted by regex and
documented as never-user-input (`sandbox.js:158-166`); the render service composes fixed
arguments (`render.js:45-49`). PLA-240 formalizes that into the service's request schema.

**Specification for PLA-240:**

- **Trust boundary:** only the sandbox service talks to the Docker daemon; the
  web/API process does not have Docker socket access. A web-process RCE can *request* a
  render, not run arbitrary containers.
- **Filesystem mounts:** project mounted **read-only** at `/work`; a single writable
  scratch out-dir at `/out`; nothing else (as today, `sandbox.js:30-31`). Ingestion
  already narrows the mount to one document's directory (`ingest.js:41-43`) — keep that.
- **Network policy:** `--network none` (unchanged, `sandbox.js:26`).
- **Image pinning:** pin the three images by **digest**, not `:latest`
  (`config.js:152-155` today) — supply-chain integrity for code that parses untrusted
  documents (T-26).
- **Resource limits:** keep cpu/memory/pids caps and the 60 s kill; **add** `--ulimit
  fsize` so a renderer cannot fill the host disk through `/out`, and enforce a
  **concurrency cap / queue** on sandbox jobs (today ingestion fans out via bare
  `setImmediate` with no limit — `ingest.js:186-188`; render is viewer-triggerable —
  `routes/render.js:52`; T-22).
- **Privilege expectations:** add `--user` (non-root in-container), `--read-only` root
  fs with a `--tmpfs /tmp`, `--cap-drop=ALL`, and `--security-opt=no-new-privileges` —
  all absent today (T-24).
- **Credentials/data visibility:** the sandbox environment carries **no credentials**
  today (verified: no `-e`/`--env-file` in `buildDockerArgs`) — preserve this exactly.
  Sandbox jobs see only the mounted project bytes and their parameters; never `.env`,
  never the DB, never another tenant's files.

**Alternatives considered:** (a) keep direct Docker with only flag hardening — rejected:
flag hardening (T-24) is necessary but does not remove host-root-equivalent control from
the internet-facing process (T-25). (b) A full orchestrator or per-tenant VM isolation —
rejected for the pilot: disproportionate operational weight; a local sandbox service with
a narrow surface achieves the essential property (web-process compromise ≠ host root).
(c) gVisor/Kata/rootless-Docker as the runtime under the service — **compatible** with
this decision and worth evaluating inside PLA-240, but orthogonal to moving the boundary.

---

## 7. Reverse proxy and TLS

**Decision:** a reverse proxy in front is **required** in production; the app has no TLS
of its own. Vendor-neutral (Cloudflare Tunnel and nginx both work — `deployment.md:97-116`).

Requirements:

- **TLS termination** at the proxy; HTTPS only. The session/reviewer cookie `secure`
  flag is derived from `KUHN_APP_URL` (`routes/auth.js:29-31`), so **`KUHN_APP_URL` must
  be the real https origin** or cookies ship non-Secure (T-02) — PLA-236 validates this
  at boot.
- **Proxy identity & trusted headers:** today `app.set('trust proxy', true)` trusts *all*
  hops (`index.js:38`), and magic-link/invite/review URLs are built from `req.protocol` +
  `req.get('host')` (`routes/auth.js:48`, `routes/orgs.js:109`, `routes/review-links.js:80`).
  That is a **host-header injection → credential-exfiltration** path if the origin is
  directly reachable or the proxy forwards client `X-Forwarded-*` (T-27). Production
  policy: **bound `trust proxy` to the known proxy** (hop count or subnet), ensure the
  proxy **sets** `X-Forwarded-Proto`/`Host` and **strips** client-supplied forwarding
  headers, and **block direct origin reachability**. (PLA-236.)
- **WebSocket & SSE support:** the proxy must forward WS upgrades (Yjs) and not buffer SSE
  (`X-Accel-Buffering: no` is already set — `routes/sse.js`); the job-scoped agent stream
  has **no heartbeat**, so proxy idle timeouts must accommodate long turns or PLA-245/246
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

**Decision:** "one recoverable Kuhn deployment" is a **single consistent snapshot** of
everything below. This is the consistency contract PLA-242 implements.

**What one recoverable deployment contains:**

1. **Database** — all three SQLite files via a **hot** backup (`.backup`/`VACUUM INTO`/
   `db.backup()`), never `kuhn.sqlite` alone (WAL carries uncommitted data — T-34).
2. **Project files** — `data/files/` **including every `.git`** (history lives inside the
   workspace; a naive filter drops it).
3. **Org library** — `data/orgs/` originals (**not** reconstructible from the DB).
4. **Git histories** — captured with (2), inside the workspaces.
5. **Configuration** — `agent-backend/.env`: the only home for `ANTHROPIC_API_KEY`,
   `KUHN_SESSION_SECRET`, and `KUHN_SMTP_URL` (`deployment.md:50-51`).
6. **Secret / master-key dependencies** — **`KUHN_SESSION_SECRET` is a restore-critical
   secret**: losing it invalidates every live session; rotating it logs everyone out.
   Back it up **isolated from the data** (a backup that contains both the encrypted data
   and the key that protects it defeats the point — T-32).
7. **`guidance-docs/`** — required at runtime, not just build time; a deploy missing it
   *silently* degrades the catalog (`db/seed.js:112-115`) rather than failing.
8. **Application version/commit** — because migrations are forward-only with no version
   table today (§3), restoring a DB under an *older* binary is undefined. Record the
   commit with the snapshot; PLA-241's migration ledger makes this checkable.

**Required consistency model (the contract for PLA-242):** the DB hot-backup and the file
snapshot should be taken close together, ideally with the **worker paused/drained** so no
job is mid-write across the DB/filesystem boundary (there is no cross-store transaction).
Acceptable skew for the pilot: a few seconds, bounded by pausing new job claims during the
snapshot. Backups are **encrypted and access-controlled**, and **retain tenant isolation**
(a restore reproduces the same per-tenant boundaries). Restore must be **drill-tested**
(PLA-242 acceptance), not assumed.

**Scale trigger:** when a full consistent snapshot's **backup window** exceeds the
tolerable pause/skew, move to incremental/streaming backup (WAL archiving for SQLite, or
Postgres PITR after the DB migration).

---

## 9. Deployment artifact

**Decision:** package the server components (backend + built webapp) as an **immutable
container image**, with the three sandbox images **pinned by digest**. Replace the current
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
choice for PLA-248, not a mandate to move persistence or collaboration into containers —
the DB and files stay on host-mounted durable storage regardless.

**What PLA-248 owns (not implemented here):** the image build, digest pinning, the
upgrade/rollback runbook, migration preflight ordering (image up → migration gate →
readiness), and how the DB/file volumes and `.env` are mounted into the container.

---

## 10. Observability and health boundaries

**Decision:** define the health/observability topology so PLA-245/246 have concrete
targets. Not implemented here.

- **Which processes expose readiness/liveness:** both the **web** and the **worker**.
  Today `/health` is unauthenticated (correct) but reports only `db: SELECT 1` + uptime
  (`routes/health.js:6-14`) and leaks `db.error` (T-36).
- **Liveness vs readiness:** liveness = the process can be supervised; **readiness must
  fail** when a required dependency is unhealthy — DB schema/migration state, the job
  worker/lease heartbeat, the sandbox service, and (for the worker) provider
  reachability. A ready web process that cannot actually serve safely is worse than a
  failed one (it takes traffic).
- **"Ready" means:** DB open at the expected migration version; worker leases current;
  sandbox service reachable; static assets present.
- **Structured logs:** JSON to stdout (collected by the platform), **with secrets and
  content redacted** — closing the raw-token-to-stdout hazard (T-08) is a log-hygiene
  requirement, not just an SMTP one.
- **Correlation:** request id, safe internal user id, org, project, job, worker, and
  provider-profile ids threaded across HTTP, WS, jobs, and provider calls (PLA-245).
- **Shutdown/draining:** SIGTERM must drain connections, stop claiming new jobs, let
  in-flight turns reach a checkpoint or re-queue, **flush pending git commits**, and close
  the DB — none of which exists today (no signal handler; `unref`'d commit timers lost).
  (PLA-246, PLA-244.)

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
- **Worker concurrency.** One worker is the pilot limit; more workers need a shared DB
  reachable from multiple processes safely. Trigger: agent/ingest backlog a single worker
  can't clear. Forces: Postgres (multi-writer) and possibly a real queue.
- **Backup windows.** A full consistent snapshot requires a brief worker pause. Trigger:
  data volume makes that pause unacceptable. Forces: incremental/streaming backup (§8).
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

- **Downstream issues get concrete direction** without re-deciding topology: PLA-244
  (worker + leases), PLA-240 (sandbox service + hardening), PLA-241 (migration ledger +
  `busy_timeout` + fail-closed init), PLA-242 (consistent snapshot contract), PLA-236
  (boot-time config validation incl. `trust proxy`/`KUHN_APP_URL`/SMTP), PLA-246
  (readiness/shutdown), PLA-248 (immutable artifact), PLA-245 (correlated logs/metrics).
- **The pilot keeps SQLite and local files** because the workload — one deployment, low
  concurrency, Yjs off the DB, worker-serialized heavy writes — makes them technically
  sound, not merely convenient.
- **The two genuinely unsafe co-residencies are separated:** durable background execution
  (PLA-244) and host-privileged Docker control (PLA-240). Everything else stays simple.
- **Multi-instance is deferred as one coherent step** (Yjs + registries + Postgres + LB),
  behind explicit triggers, rather than partially and prematurely.
- **This ADR does not implement anything.** It is the reference the milestone-3/4 issues
  build to; where an issue's local instinct contradicts it (e.g. "add Redis," "go Postgres
  now," "keep Docker in the web process"), this ADR is the tie-breaker.

## References

- ADR 001 — provider-agnostic runtime foundation: pending in [PR #69](https://github.com/soundtrip-health/kuhn/pull/69); lands at `docs/adr/001-provider-agnostic-runtime-foundation.md` on merge
- [Threat model & data classification](../security/threat-model.md) (PLA-224)
- [architecture.md](../architecture.md), [deployment.md](../deployment.md), [data-pipeline.md](../data-pipeline.md)
