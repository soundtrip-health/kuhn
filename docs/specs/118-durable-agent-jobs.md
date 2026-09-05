# Spec: Durable, leased, cancellable, resumable agent jobs (issue #118)

**Status:** design — proposed for review; stage 0 landed (PR #140), stages 1–5 to be split into issues (§12)
**Issues:** [#118 — durable job lifecycle](https://github.com/soundtrip-health/kuhn/issues/118) (STH-25);
seeded by [#136 — interrupt an agent](https://github.com/soundtrip-health/kuhn/issues/136);
consumed by [#113 — parallel projects and chats](https://github.com/soundtrip-health/kuhn/issues/113)
**Antecedents:** ADR 002 §2 (the web↔worker seam is SQLite: leases, durable event rows,
persisted control state), ADR 001 (canonical continuation), the threat model's lifecycle
threats (T-28 stale jobs after suspension, T-29 retry storm / no wall-clock bound, T-33 no
graceful shutdown), story 027 (detachable runs + reconnect), issue #110 (budget pause as a
resumable state).

## 1. Goal

A job is a **durable record with an explicit lifecycle**, not a promise chain in one
process's memory. Concretely (the issue's acceptance): killing the process during a chat
turn, a tool call, a sub-agent run, or a wait for the user leaves every job in a documented,
recoverable state with **no duplicate side effects**; cancellation and org suspension reach a
running job promptly — including one that restarted meanwhile; two workers can never own the
same active job.

### Non-goals (this spec)

- Multiple worker hosts / Postgres (ADR 002 "later scale topology").
- Changing the agent tool surface or prompts beyond the `ask_user` turn-boundary change (§7).
- Replaying provider turns for exactness: a reclaimed job resumes from its last durable turn
  boundary; the half-finished turn is redone (its tool effects are not — §9).

## 2. Where we are (after #136)

| Concern | Today | Gap against §1 |
|---|---|---|
| Job row | `jobs` with `status ∈ pending, running, done, error, interrupted, cancelled` | no queued/waiting/retry/cancel-requested states; no owner, lease, or heartbeat |
| Live run | in-memory `RunHandle` (`agents/runs.js`) for detachable chat runs only | lost on restart; sub-agent and seeding runs are not addressable |
| Cancel | `cancelRun(state)` aborts the turn, releases `ask_user`, cascades to sub-agents through the parent's signal, marks rows cancelled, emits a `cancelled` terminal (#136) | in-memory only: a cancel that races a restart is lost; nothing checks a persisted flag |
| Waiting for the user | `questions.js` in-memory registry; the run's promise is parked inside the tool call; reconnect re-emits the question (story 027) | a restart loses the question and the parked turn; buffered events grow without bound (T-28) |
| Restart | `markOrphanedJobsInterrupted()` flips pending/running → interrupted; the user re-dispatches | recovery is manual and coarse; budget-paused jobs are the only resumable class |
| Suspension / removal | checked at HTTP entry (`requireProjectRole`) and by `search_org_knowledge` | not re-checked during a run: a suspended tenant's run keeps mutating files and spending until it ends (T-28) |
| Retries | per-turn exponential backoff on `retryable` provider errors; resume-on-retry | no wall-clock bound, no circuit breaker (T-29); tool calls inside a redone turn could replay |
| Sub-agents | `parent_job_id`, shared budget object, parent signal → child teardown (#136) | budget is an in-memory object; the tree is not queryable as one unit |

## 3. Job model

```
              ┌──────────── retry_wait ◄──────────┐ (transient provider error, backoff)
              ▼                                   │
queued ──► running ──► waiting_for_user ──► running (reply delivered = next turn)
              │  ▲                                ▲
              │  └──────── reclaimed after crash ─┘ (lease expired; resume from last turn boundary)
              ├─► done
              ├─► error            (terminal provider/tool failure, budget pause = error+handoff as today)
              ├─► cancelled        (user Stop, disconnect of a non-detachable run, parent stopped)
              └─► interrupted      (process died and the job is NOT resumable: pre-#118 rows only)
cancel_requested is a persisted FLAG on any non-terminal state, honoured at the next control point.
```

**Columns added to `jobs`** (all nullable; `init.js` COLUMN_MIGRATIONS; the `status` CHECK is
widened by a table rebuild like the #133 provider migration):

| Column | Meaning |
|---|---|
| `root_job_id` | the top-level job of the tree (self for depth 0) — one query for the whole tree, one budget row |
| `worker_id` | `${hostname}:${pid}:${startedAt}` of the process that holds the lease |
| `lease_until`, `heartbeat_at` | lease expiry and last heartbeat; a job whose lease has expired is reclaimable |
| `attempt` | how many times the job has been (re)claimed |
| `cancel_requested_at`, `cancel_reason` | the persisted cancel flag (`user`, `suspended`, `parent`, `shutdown`) |
| `waiting_since` | set while `waiting_for_user` |
| `wake_at` | for `retry_wait`: when to retry |
| `deadline_at` | wall-clock bound for the run (T-29): `AGENT_RUN_MAX_MS`, default 2 h |
| `budget_used` | weighted budget consumed by the tree, kept on the root row (replaces the shared in-memory object across restarts) |

**Tables added:**

- `job_events (id INTEGER PK, job_id, root_job_id, seq, type, payload JSON, created_at)` — the
  worker → web plane (§6).
- `pending_questions (job_id PK, agent, question, asked_at)` and `job_replies (job_id, reply,
  replied_by, created_at)` — the durable `ask_user` state (§7).
- `tool_effects (job_id, tool_call_id PK, tool, effect_key, applied_at)` — the exactly-once
  record for mutating tools (§9).

## 4. Claim and lease

Every run — chat, dispatch, seeding stage, resume — is **enqueued** as a `queued` row and
**claimed** by a worker loop, never executed directly by the request handler. With the web and
worker still one process (stage 1–3) the loop is in-process; stage 4 moves it out.

```sql
UPDATE jobs SET status = 'running', worker_id = $me, lease_until = now + $ttl,
                heartbeat_at = now, attempt = attempt + 1
WHERE id = (SELECT id FROM jobs
            WHERE status IN ('queued', 'retry_wait') AND (wake_at IS NULL OR wake_at <= now)
               OR (status IN ('running', 'waiting_for_user') AND lease_until < now)
            ORDER BY created_at LIMIT 1)
RETURNING *;
```

SQLite's single writer makes the claim atomic; **two workers can never own the same active
job** because ownership *is* the row update. The lease TTL (default 60 s) is renewed by a
heartbeat every TTL/3 while a turn runs; a heartbeat that finds `cancel_requested_at` set or
`lease_until` already expired (another worker reclaimed) aborts the in-flight turn. Per-class
concurrency (`AGENT_MAX_CONCURRENT_RUNS`, per org and per user — T-21) is enforced at claim
time, not at enqueue.

## 5. Control plane: web → worker

Control is **persisted first, signalled second**. `POST /jobs/:id/cancel` sets
`cancel_requested_at`/`cancel_reason` on the root row and every open descendant (one UPDATE by
`root_job_id`), then — when the job is owned by this process — calls `cancelRun(state)` for the
immediate abort #136 built. A worker consults the flag at every **control point**:

1. before each provider turn,
2. on each heartbeat (so a long provider turn is aborted within TTL/3 ≈ 20 s at worst),
3. before executing any tool with `readOnly: false` (§8 runs the tenancy gate at the same point),
4. when a `waiting_for_user` job wakes.

Org suspension, project deletion, and membership removal are the same mechanism: the
responsible route sets `cancel_requested_at` with reason `suspended`/`deleted`/`removed` on the
tenant's open jobs (a `cancelJobsWhere(...)` helper), and the tenancy gate (§8) catches any job
that was mid-turn.

## 6. Event plane: worker → web

The channel tee (`publishProjectEvent`) already sees every top-level event. Stage 3 makes the
worker **append each event to `job_events`** (with a per-job `seq`) *before* pushing it to the
in-process hub, and makes every SSE consumer — the chat stream, `reconnect`, the project feed
— read from the table with a cursor: `Last-Event-ID: <job_events.id>` replays what was missed,
then follows live pushes. When web and worker share a process the live push is the fast path
and the table is the recovery path; across processes the web polls the table (or a `NOTIFY`-like
local wakeup) — ADR 002 §2.3. Retention: `job_events` rows are pruned with their job after
`JOB_EVENTS_RETENTION_DAYS` (default 30); `text_delta` events are not stored (the `text` event
carries the full turn), which keeps the table small.

## 7. Waiting for the user survives a restart

Today `ask_user` parks the *tool call*: the provider turn is open, the SDK subprocess is alive,
and the answer arrives as the tool result. That cannot be reconstructed after a restart on
either runtime. The change: **`ask_user` becomes a turn boundary.**

1. The tool records `pending_questions(job_id, agent, question)`, sets the job
   `waiting_for_user`, releases the lease, and returns a *closing* tool result to the runtime
   (`[Waiting for the user's answer — it will arrive as the next message.]`). The turn ends;
   the runtime's canonical continuation (ADR 001) records the closed call. The worker holds
   nothing in memory.
2. `POST /jobs/:id/reply` persists `job_replies` and flips the job to `queued` with
   `input = reply` (rendered as `[Answer to your question "…"]: …`), keeping `session_id` and
   `continuation`. The claim loop resumes it as the next turn — the Claude adapter resumes the
   session, the Pi adapter resumes the continuation — exactly the mechanics the budget-pause
   resume (#110) already proves.
3. The chat UI keeps its behaviour: the `question` event renders the card; the reply goes to
   the same endpoint; the run's stream is re-attached to the resumed job by `root_job_id`
   (there is no longer a "parked consumer" to protect). `GET /pending` reads
   `pending_questions`, so it is correct after a restart, and `reconnect` becomes "attach to
   the root job's event stream from cursor N".
4. `question_expired` disappears for chat runs (nothing expires); a Stop while waiting sets the
   cancel flag and deletes the pending question (#136 semantics preserved).

Prompt impact: the answer arrives as the next user message rather than as the tool's return
value. The `ask_user` description tells the model so; the model already handles
"[No reply received…]" text results, and a trial on the PM interview flow is part of the
stage-2 acceptance.

## 8. Tenancy gate during a run

`runGate(job)` — `checkOrgAccess(job.user_id, org)` for the job's user plus a project-exists
check, memoized for 5 s per job — runs at the control points of §5. A failing gate aborts
the turn and terminates the tree with `status = 'cancelled'`, `cancel_reason = 'suspended' |
'deleted' | 'removed'`, and a terminal `error` event `reason: 'access_revoked'` with a
non-leaking message. Together with §5's flag this closes T-28: a suspended tenant's run
stops at its next tool call or heartbeat, not at its natural end.

## 9. Retries, deadlines, and exactly-once tool effects

- **Retry policy by error class** (contract.js codes): `rate_limit`/`overloaded`/`server`/
  `network` → `retry_wait` with full-jitter backoff (as today) but *persisted* (`wake_at`), so a
  restart mid-backoff resumes the wait instead of losing the job; `context_overflow`/
  `provider_error`/`auth` → terminal `error`; `session_not_found` → the #109 hand-off, once.
  A per-provider circuit breaker (N consecutive `overloaded` across jobs → hold new claims for
  that provider for 60 s) replaces N independent retry storms (T-29).
- **Wall-clock deadline** `deadline_at` per root job; exceeding it cancels the tree with
  reason `deadline` and the budget-pause style hand-off note so the user can resume.
- **Mutating tool calls are never blindly replayed.** A reclaimed job redoes only its
  interrupted *turn*; within it the provider may re-issue the same tool calls. Every tool with
  `readOnly: false` records `tool_effects(job_id, tool_call_id, effect_key)` in the same
  transaction as (or immediately before) its effect, and a call whose `(job_id, tool_call_id)`
  already exists returns the recorded result instead of acting. `effect_key` (e.g.
  `write:draft/main.md@sha`) lets the reconciliation of ADR 002 §2.4 detect a half-applied
  effect after a crash between the effect and its record.

## 10. Parent and sub-agent jobs

`root_job_id` ties the tree; the budget lives on the root row (`budget_used`, updated per turn
with the same weighted figure as today — the org ledger stays per job); cancellation cascades
by `root_job_id` (§5) and, in-process, by the parent's signal (#136). A sub-agent is enqueued
and claimed like any job, so a crash during a dispatched RA leaves the RA `running` with an
expired lease → reclaimed and resumed, while the parent's `dispatch_agent` call — itself a tool
call in a redone turn — finds the child by `(parent_job_id, tool_call_id)` and awaits it rather
than starting a second RA.

## 11. Verification (the acceptance)

A crash-matrix test (`agents/durability.test.js`, scripted runtime + in-memory SQLite, killing
the worker loop at each point) asserting, for each of *chat turn*, *tool call (mutating)*,
*sub-agent mid-turn*, *waiting for user*, *retry_wait*: the row states after the crash, the
states after reclaim, that the mutating effect happened exactly once (`tool_effects`), that a
cancel flagged during the outage terminates the reclaimed job without a provider call, and
that the event cursor replays without gaps or duplicates. Plus a token-free browser check
extending `stop-check.mjs`: restart the isolated backend while parked on a question, reload,
answer, and see the run finish.

## 12. Stages and drafted issues

| Stage | Scope | Depends on |
|---|---|---|
| 0 ✅ | `cancelRun`, `cancelled` terminal, tree stop via parent signal, `job` markers (#136/#137, PR #140) | — |
| 1 | States + columns + `status` rebuild migration; persisted cancel flag honoured at control points; tenancy gate (§8); wall-clock deadline; `root_job_id` + budget on the root row | PR #140 |
| 2 | `ask_user` as a turn boundary; `pending_questions`/`job_replies`; `reply` = enqueue next turn; `pending`/`reconnect` from the DB | 1 |
| 3 | `job_events` + cursor replay for chat, reconnect, and project feed; in-process fast path | 1 |
| 4 | Claim loop with leases/heartbeat; enqueue everywhere (chat, dispatch, seeding, resume); reclaim on expired lease; graceful shutdown (SIGTERM → release leases, T-33); worker as a separate process (ADR 002 §2) | 2, 3 |
| 5 | `tool_effects` exactly-once + reconciliation (ADR 002 §2.4); provider circuit breaker; persisted `retry_wait` | 4 |

Drafted issue titles (bodies are the sections above):

1. **Job lifecycle stage 1 — explicit states, persisted cancel flag, tenancy gate, deadline** (§3, §5, §8; T-28, T-29)
2. **Job lifecycle stage 2 — `ask_user` as a durable turn boundary** (§7)
3. **Job lifecycle stage 3 — durable job events with cursor replay** (§6; ADR 002 §2.3)
4. **Job lifecycle stage 4 — claim/lease worker loop, reclaim on restart, graceful shutdown** (§4, §10; ADR 002 §2)
5. **Job lifecycle stage 5 — exactly-once mutating tool effects and provider circuit breaker** (§9; ADR 002 §2.4)
