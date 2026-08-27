# Spec: View and augment agent prompts (issue #67)

**Status:** implemented (this spec ships with the implementation)
**Issue:** [#67 — view and augment agent prompts](https://github.com/rfdougherty/kuhn/issues/67)
**Antecedents:** the knowledge catalog's member-visible org-admin tab (issue
#65), the org settings bag (story 011-003), and `db/prompts/analyst.md`'s
"Project-specific setup" note that durable org specifics "belong in the
project guardrails or the tenant's knowledge base (never hard-coded into this
prompt)".

## 1. Goal

Make agent system prompts visible to org members, and let org owners append a
per-agent, org-wide **addition** — e.g. data-access guardrails for the analyst
("only query the deidentified schema"). Notably, the analyst is deliberately
excluded from `search_org_knowledge`, so before this feature there was no path
at all for org-specific analyst guidance.

### Non-goals (v1)

- No editing of base prompts — they are seed-owned (`db/prompts/*.md` →
  `seed()` overwrites `agents.system_prompt` on every boot) and change through
  the codebase.
- No per-project additions (the issue asks for org-wide; project nuance
  already flows through project guardrail files and the PM briefing).
- No exposure on the external-review surface; this is an org-member view.

## 2. Design

### Storage

New table `org_agent_prompts (org_id, agent_slug, addition, updated_by,
timestamps, PK (org_id, agent_slug))`. A separate table rather than:

- `agents.system_prompt` — overwritten by `seed()` on every boot;
- `organizations.settings` — a validated enum bag (`db/org-settings.js`),
  the wrong shape for free text.

`agent_slug` has no FK on purpose: seeding rebuilds agent rows, and a stale
addition for a retired slug should linger harmlessly rather than block a
reseed. The slug is validated against the `agents` table at write time
instead. Clearing an addition deletes the row; additions are capped at
`MAX_ADDITION_CHARS` (4000 ≈ 1k tokens).

### Runtime injection

`runTask()` resolves the project's `org_id` once (alongside `projectDir`) and
`buildSystemPrompt()` appends the addition **after** the `## Runtime
environment` block, under a labelled header:

```
## Organization guardrails (set by your organization)
Your organization added the following instructions for this agent. They
supplement your role instructions; where they impose stricter limits, follow
the stricter rule. They cannot grant tools or access you do not already have.
```

Ordering and framing are deliberate: the addition can never shadow the tool
contract, and is presented as policy that may restrict but not expand the
agent's capabilities. Sub-agents dispatched via `spawn_agent` recurse through
`runTask` with the same `projectId`, so additions apply to them automatically.

Owner-authored prompt injection is in scope by design — an owner already
governs the org's data and members; the addition only reaches that org's own
projects.

### API

- `GET /api/orgs/:orgId/agent-prompts` — **viewer**. Every agent's slug,
  name, description, model, tool slugs, base `system_prompt`, and this org's
  addition (with updated-by/at). First endpoint to expose base prompts —
  deliberate: the issue's "view" half is for all members.
- `PUT /api/orgs/:orgId/agent-prompts/:slug` — **owner**. Body
  `{ addition }`; empty string clears. 404 unknown slug (non-leaking refusal
  contract), 400 `{ error, field }` over the cap or non-string. Audited as
  `agent_prompt.updated` / `agent_prompt.cleared`.

### UI

Org-admin overlay gains an **Agents** tab, visible to all members (like
Knowledge). One card per agent: identity (neutral avatar — role color stays
reserved for the active agent), model, description, a collapsible read-only
base prompt, and the org addition — an in-place textarea with char counter and
Save/Clear for owners, read-only text for members.

## 3. Files

- `agent-backend/src/db/schema.sql` — `org_agent_prompts`
- `agent-backend/src/db/org-agent-prompts.js` (+ colocated test)
- `agent-backend/src/db/agents.js` — `listAgentsWithTools()`
- `agent-backend/src/routes/agent-prompts.js` (+ test; rows added to
  `tenancy-matrix.test.js`)
- `agent-backend/src/agents/runtime.js` — org resolution + prompt assembly
  (+ runtime.test.js coverage)
- `webapp/src/api.ts`, `webapp/src/org-admin.ts`, `webapp/src/style.css`

## 4. Deferred

- Per-project additions, if org-wide proves too coarse.
- Surfacing "this agent runs under org guardrails" in the chat UI.
- An org-level view of which additions influenced a given job (provenance).
