# Spec: Shared project memory for agents (issue #150)

**Status:** design reviewed 2026-09-14 (§10); stage 1 in progress. Stages in §9.
**Issue:** [#150 — need better memory](https://github.com/soundtrip-health/kuhn/issues/150)
**Antecedents:** the meta-manuscript incident (the RA re-ran a clean-up the previous RA run had
already finished, because the only record of it was in the PM's context window); #147 / #145
(deterministic hooks over prompt rules); #118 stage 1 (`root_job_id`, the run gate on mutating
tools); #113 (durable chats); the org knowledge library (#65: FTS5 over ingested chunks) and
the help guide index (#170: `guide_fts`), whose search pattern this reuses.

## 1. Goal

Agents working on one project **share a durable, queryable memory** that any of them reads
and writes directly, so that:

- what one run learned or did is available to the next run of *any* agent without the PM
  relaying it (and without the PM's context window being the only copy);
- coordination facts ("the reference store was audited on 2026-09-08 and the 13 corrupted keys
  are gone") are written by *code* at the moment they become true, not left to a model to
  remember to say;
- the PM does less pass-through: a dispatch result is stored once and pointed at, not pasted.

The acceptance is the #150 incident itself, as a conformance scenario (§8): RA run 1 finishes
a clean-up; RA run 2, dispatched later with a related task, starts *knowing* the clean-up
happened.

### Non-goals

- Org-wide memory: the org knowledge library already covers curated cross-project knowledge.
- Replacing the transcript: `conversations` / `messages` stay the full record; memory is the
  distilled, addressable layer on top.
- Embeddings / vector search in the first stages (§6 says why and when).
- Cross-user privacy inside a project: memory is project-scoped like files are. A member who
  can read the project reads its memory.

## 2. Where we are

| Concern | Today | Gap against §1 |
|---|---|---|
| Institutional memory | `pm/status.md`, `pm/decisions.md`, `pm/issues.md` — markdown the PM is *asked* to maintain | written by one agent, by prompt rule; not queryable; a sub-agent never reads it unless told; stale the moment the PM forgets |
| Dispatch results | the child's final text is returned to the parent's tool call and logged in the parent's conversation | lives in the PM's context and the transcript only; the next RA run starts cold |
| Cross-run continuity | chat rows carry the provider session + continuation per (project, agent, user) | per agent and per user: the writer's chat knows nothing the RA's chat learned |
| Search | FTS5 over org-library chunks and the feature guide | nothing indexes project-level facts |

## 3. Data model

```sql
CREATE TABLE IF NOT EXISTS project_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'task_state', 'issue', 'note')),
  key           TEXT,            -- optional stable slug; at most one LIVE entry per (project_id, key)
  body          TEXT NOT NULL,   -- markdown, bounded (§4: 2 KB); immutable once written
  tags          TEXT NOT NULL DEFAULT '[]',  -- JSON array of short strings
  source_agent  TEXT,            -- agent slug that wrote it; NULL for a human
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,   -- provenance; root_job_id reachable through it
  auto          INTEGER NOT NULL DEFAULT 0,  -- 1 when the runtime wrote it (§5), 0 for a model or human write
  supersedes_id INTEGER REFERENCES project_memory(id) ON DELETE SET NULL,  -- the live entry this one replaced
  retired_at    TEXT,            -- soft delete: retired entries are excluded from recall, kept for audit
  retired_by    TEXT,            -- agent slug, 'user:<id>', 'supersede' or 'cap'
  retire_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_live_key
  ON project_memory(project_id, key) WHERE key IS NOT NULL AND retired_at IS NULL;
-- External-content FTS5 shadow + triggers, the guide_fts / org_chunks_fts pattern.
CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts USING fts5(body, tags, key, content='project_memory', content_rowid='id');
```

**Kinds.** `fact` — something true about the project or its materials ("the NSDUH extract has
38 210 rows after exclusions"); `decision` — a choice and its rationale, with who made it
("PI chose JAMA Netw Open over BMJ, 2026-09-10"); `task_state` — what a run did and left
undone (the dispatch-outcome record, §5); `issue` — an open question, data concern or
unresolved reviewer finding (retiring it means it is resolved — this is what `pm/issues.md`
held); `note` — anything else. `key` gives an entry a stable identity
(`reference-store-audit`, `target-journal`) so a later write *replaces* it instead of
accumulating near-duplicates; keyless entries append.

**Rows are immutable.** A write never updates a body. A keyed write inserts a new row and
retires the previous live row for that key with `retired_by = 'supersede'`, the new row's
`supersedes_id` pointing back. So history is never lost, the FTS shadow needs only insert
and delete triggers, and an audit reads as a chain. (The one mutable column set is the
retire triple.)

**PI-authored entries are protected.** A live entry written by a human — `source_agent` NULL:
a PI answer recorded from `ask_user`, or a human write from the UI / `/remember` (agent writes
carry the acting user in `user_id` for attribution, so that column does not distinguish them)
— cannot be superseded or retired by an agent write. The tool returns an error naming the entry and telling the agent
to raise the disagreement with the user — `ask_user` where it has it, otherwise an `issue`
entry or a note in its reply — rather than overwrite. Agents should challenge the PI when the
evidence warrants it; they must never do so silently.

**Bounds.** `body` ≤ 2 KB, ≤ 8 tags, and a per-project cap (default 2 000 live entries). Above
the cap the oldest live `auto` entries (§5 — dispatch and run outcomes, keyed or not) are
retired first with `retired_by = 'cap'`, then the oldest keyless `note` / `task_state` entries;
keyed model-written entries and every `decision` / `issue` survive. Memory is a summary layer;
anything longer belongs in a file the entry points at.

## 4. Tools

Three neutral tools in `agents/tools/memory.js`, granted to every agent except `help`:

| Tool | Effect | Contract |
|---|---|---|
| `remember` | write | `{ kind, body, key?, tags? }` → the entry id. A keyed write supersedes the live entry under that key (§3); a PI-authored live entry refuses the write. Bounded as §3. Goes through the #118 run gate like every mutating tool. |
| `recall` | read | `{ query?, kind?, tags?, limit=10 }` → ranked entries (BM25 over body/tags/key, ties by recency; no `query` = most recent first). Each hit carries `id`, `kind`, `key`, `body`, `source_agent`, `created_at`, `job_id`. |
| `forget` | write | `{ id, reason }` → retires an entry (soft delete, provenance kept). Refuses a PI-authored entry (§3). Editors can retire anything from the UI (§7). |

`recall` is read-only and ungated; `remember` / `forget` are audit-logged (`memory_write`
with `jobId`, `kind`, `key`) like every other mutation. Every `recall` — the tool's and the
injection's (§6) — also logs `memory_recall` with the query terms, hit count and hit ids from
day one, so the embeddings decision (§6) has data without a later change.

## 5. Deterministic writes — the hooks (#145)

Prompt rules alone would recreate #150 with a smaller model. The following are written by code:

1. **Dispatch outcomes.** When `dispatch_agent` returns, the runtime stores the child's final
   reply as an `auto` `task_state` entry: `key = task:<child job id>`, body = the first 2 KB of
   the reply, tags `[<child agent>, dispatch]`, `job_id` = the child job, `source_agent` = the
   child. The PM's tool result gains one line — `Recorded as memory #123.` — so the PM can
   point at it instead of pasting. (This alone would have carried "the 13 keys are already
   gone" into the next RA run.)
2. **Top-level run outcomes — mutating runs only.** The same for a top-level run's final
   assistant text (`key = run:<job id>`), *only when the run executed at least one tool with
   product-side effects* (the #118 gate already sees every such call: a file write, a
   reference change, a comment, a dispatch, a `remember`). A read-only turn — "what does
   section 3 say?", "fixed the typo" — leaves no trace; recording every chat turn would fill
   memory with noise that no cap could keep useful.
3. **Reference-store changes.** `remove_reference`, `update_reference` and a `verify_references`
   run that changed the verdict of any key write/upsert a `fact` under
   `key = references:<cite key>` ("removed 2026-09-08 by ra: duplicate of lewis2020" /
   "resynced from arXiv 2005.11401v4, verified"). The store is the source of truth; the memory
   entry is the *why* and *when*, which the store does not hold.
4. **PI decisions.** A reply to an `ask_user` question is stored as a `decision`
   (`key = question:<job id>:<n>`, body = question + answer, `user_id` = the PI). Today those
   answers vanish into one agent's session.
5. **Budget / deadline pauses.** The hand-off note (#110, #118) is also a `task_state` entry
   (`key = handoff:<job id>`), so a *different* agent resuming the project sees it.

Everything else — facts, rationale, project conventions — is the model's to `remember`, with
prompt guidance (§9 stage 2) on *what* is worth keeping.

## 6. Injection: how memory reaches a run

Recall on demand is not enough (the RA in #150 did not know there was anything to ask about).
At task start the runtime appends a bounded **Project memory** section to the *user prompt*
(after the task text, never in the system prompt, which stays byte-stable and cacheable):

- the newest live `decision` and `issue` entries (≤ 10 together) and the newest `task_state`
  entries (≤ 10, so the last few things anyone did are always visible);
- a `recall` for the task input itself (top 5 by BM25 over the task text's content words —
  the guide search's term sanitizer with its stopword list, so a long task neither breaks
  FTS5 MATCH syntax nor matches everything), so a task about "arXiv references" surfaces
  `references:*` facts and the audit `task_state`;
- **headlines, not bodies**: each entry renders as `- [#id kind, agent, date] <first ~200
  characters>` — the full body is one `recall` away, and a dispatch reply written for the PM
  is chatty prose that would blow the budget. Total ≤ 3 KB.
- a one-line preface: entries are dated summaries; the reference store, the files and the
  transcript are the source of truth, so verify before acting on a state claim that matters.

Sub-agents get the same section built from *their* task text. This is a prompt-size cost of a
few hundred tokens per run — small next to the pass-through it replaces.

**Continued sessions get the delta.** A top-level chat resumes its provider session, so the
full section on every turn would repeat itself into the transcript. A run that resumes a
session (a continuation or session id is present) gets only the entries created since the
chat's previous job started, under the same caps; a fresh session gets the full section. A
turn with nothing new gets no section at all.

**Why not embeddings now.** BM25 over short, keyed, tagged entries written by agents about a
single project is precise enough for the failure this fixes: the entries share vocabulary with
the tasks that need them (cite keys, file names, section names). Semantic search buys recall
on paraphrase, at the cost of an embedding provider (or a local model) in the render/export
sandbox's no-network world, a vector index, and a second ranking to explain. Decide it from
evidence: §8's conformance scenario plus the `memory_recall` log (§4: query terms, hit count,
hit ids — from stage 1) tell us whether keyword recall misses in practice. If it does, an
embeddings column on the same table is an additive stage (§9 stage 4).

## 7. UI

Stage 1 ships a read-only `GET /api/projects/:id/memory` (viewer role; `?q=`, `?kind=`,
`?retired=1`) so the memory of a real project can be inspected before the tab exists.

A **Memory** tab in the project browser: entries newest first, filter by kind/agent/tag,
full-text search (the same `recall`), and for editors: edit body, retire, add a `decision` or
`fact` by hand. A retired entry shows struck through for a week, then hides. The chat's
`dispatch` job markers link to the entry they recorded. Nothing here needs a new capability
model — it is the project's data, under the project's roles.

## 8. Verification

- **Conformance scenario `memory-carries-over`** (the #150 repro, scripted runtime + in-memory
  SQLite): RA run 1 removes three references and reports it; RA run 2 is dispatched with "audit
  the arXiv references"; assert its prompt's Project memory section contains the `task_state`
  from run 1 and the `references:*` facts, and that run 2's scripted model, told to call
  `recall('corrupted keys')`, gets them back ranked first.
- Unit: bounds; supersede-by-key retires the old row and links the new one; a PI-authored
  entry refuses agent supersede and `forget`; the cap retires `auto` entries first; the FTS
  shadow stays in sync on insert and excludes retired rows; term extraction never produces
  an FTS5 syntax error; the injection budget holds; a resumed session gets only the delta;
  a read-only run writes no `run:` entry. Tenancy — `recall` never crosses projects (the
  tenancy matrix test gains the memory route).
- Token-free check: `memory-check.mjs` writes entries through the tool, reloads, and verifies
  the Memory tab renders and a retire hides them.

## 9. Stages and drafted issues

| Stage | Scope | Depends on |
|---|---|---|
| 1 | Table + FTS + `remember` / `recall` / `forget`; injection (§6, headlines + delta); deterministic writes 1, 2 (mutating runs), 4, 5 of §5; `memory_write` / `memory_recall` log lines; read-only REST listing; a runtime-appended "Project memory" paragraph in every granted agent's system prompt (what the tools are for, PI entries are not overwritten); conformance scenario | #118 stage 1 (gate, `root_job_id`) — landed |
| 2 | Per-agent prompt guidance (what each role should remember, how to cite an entry); §5 write 3 (reference-store facts); `pm/status.md` becomes a *rendering* of memory (`decision` + `task_state` + `issue`) the PM regenerates instead of hand-maintaining; `pm/decisions.md` / `pm/issues.md` retired in favour of the `decision` / `issue` kinds | 1 |
| 3 | Memory tab (§7); interchange bundle export/import of memory (`docs/specs/interchange-bundle.md` gains a `memory.jsonl`) | 1 |
| 4 | *Only if §6's evidence says so:* embeddings column + hybrid ranking | 1–2, a recall log with misses |

Drafted issue titles:

1. **Project memory stage 1 — table, tools, prompt injection, deterministic writes** (§3–§6, §8)
2. **Project memory stage 2 — agent guidance and status.md rendered from memory** (§5.3, §9)
3. **Project memory stage 3 — Memory tab and interchange** (§7)

## 10. Decisions (PI review, 2026-09-14)

1. A user's own chat messages are **not** recorded; only their answers to agent questions
   (§5.4) are, plus an explicit `/remember <text>` slash command (stage 3, with the tab).
2. Retired entries are kept indefinitely; they are small and they are the audit trail.
3. `recall` results are **not** visible through a review link — memory is working state,
   not the document.
4. Agents may challenge a PI-authored entry but never overwrite or retire it (§3). The PI's
   words: agents should challenge the PI when appropriate — humans are fallible — but not
   silently overwrite.
5. Stage 1 proceeds with the amendments above so the design can be tested on a real project;
   the mutating-run rule for run outcomes (§5.2) is the point most likely to need tuning.
