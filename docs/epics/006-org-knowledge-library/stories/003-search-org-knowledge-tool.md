# Story 003: `search_org_knowledge` agent tool

**Status:** done
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** M

## Outcome

All acceptance criteria met (2026-07-12).

- **Tool** in `agents/runtime.js` `buildMcpTools`:
  `search_org_knowledge(query, limit?)`, read-only, org derived server-side
  from the task project's `org_id` (no org parameter in the schema). Each
  passage renders with an explicit provenance line —
  `Source: "<title>" (<filename>) — section: <headingPath>` — above its
  snippet. Empty library → "no library documents yet … do not retry" (not an
  error); zero matches in a populated library → distinct "no passages
  matched" message allowing one keyword retry.
- **Seed data**: tool row + assignments to advisor/ra/reviewer/writer
  (pm/analyst excluded per Notes); prompts updated — advisor's cross-project
  knowledge language now describes the org library mechanism accurately, and
  advisor/ra/reviewer/writer are told to search before style/process/
  regulatory answers, cite source documents by name, and not retry on an
  empty library.
- **Search-layer fix found by the eval**: FTS all-terms (AND) matching zeroed
  multi-term queries when any single word was absent from every chunk.
  `searchOrgKnowledge` now retries with OR semantics when the AND pass
  returns nothing (BM25 still ranks more-term matches higher). Lifted the
  eval from 8/11 to 10/11.
- **Relevance eval** (`npm run eval:org-search -- <orgId>`, token-free,
  direct search-layer calls against the story-002 guidance-docs fixture):
  **10/11 queries ranked the expected document in the top 3** (9 of them
  \#1). The one miss: "electronic health records claims data fitness
  regulatory decision" → `considerations.pdf` (a genuinely relevant doc —
  one of its chunks contains every query term, so the AND pass matches and
  the expected `assessing.pdf` never surfaces). Verdict: FTS relevance is
  sufficient; **no embeddings story filed**. If future misses accumulate,
  this failing query is the first fixture case for it.

Verified: 193/193 vitest (6 new — allowlist exposure, org resolution +
provenance, empty-library, zero-match, backend-error tool cases in
`runtime.test.js`; OR-fallback case in `ingest.test.js`), eval run recorded
above, `db:seed` applied and assignment matrix confirmed against the dev DB.

## Goal

Let agents consult the org library. A read-only MCP tool that searches the
FTS index and returns passages with provenance, allowlisted per agent via the
existing `agent_tools` matrix — the one sanctioned crossing of the
project-root boundary. Updates the advisor/RA prompts so the advisor's
"knowledge base grows across projects" promise is finally backed by a real
mechanism.

## Acceptance Criteria

- [x] New in-process MCP tool in `agents/runtime.js` `buildMcpTools`:
      `search_org_knowledge(query, limit?)` → ranked passages, each with
      `{ title, filename, headingPath, snippet }` and an explicit provenance
      line (document + section) so agents can cite what they relied on.
      Read-only; resolves the org from the project the task runs in.
- [x] Tool definition added to `db/seed-data.js` and assigned in the
      agent→tool matrix to **advisor, ra, reviewer, writer** (pm/analyst
      excluded — see Notes); `npm run db:seed` applies it.
- [x] Prompt updates (`db/prompts/advisor.md`, `ra.md`, and where relevant
      `reviewer.md`/`writer.md`): when org guidance may exist, search it
      before answering style/process/regulatory questions, and cite the
      source document by name. Advisor's cross-project knowledge language is
      revised to describe the org library accurately.
- [x] Empty-library behavior is graceful: the tool returns a clear
      "no org library documents yet" result (not an error), and prompts don't
      induce retry loops on it.
- [x] Relevance eval: with `guidance-docs/` imported into a test org
      (Story 002 fixture), a scripted check runs ~10 representative queries
      and asserts the expected document appears in the top 3. Token-free
      (direct function/tool-layer calls, no model). Record results in this
      story on completion; they are the evidence for/against a future
      embeddings story.
- [x] Vitest coverage: tool respects the allowlist (agent without assignment
      cannot see it); results carry provenance; org resolution follows the
      project's `org_id`.

## Notes

- Files: `agents/runtime.js`, `db/seed-data.js`, `db/prompts/*.md`,
  a check script under `agent-backend/` (pattern: existing `npm run smoke`
  siblings, but token-free).
- The tool must **not** accept an org id parameter — the org is derived
  server-side from the task's project; agents never choose their tenant.
- If FTS relevance disappoints in the eval, file the embeddings story with
  the failing queries attached rather than widening this one.
- **Why pm/analyst are excluded** (decision 2026-07-12): the four included
  roles consume guidance *content* (style, process, regulatory text); pm
  orchestrates and interviews, analyst produces figures — neither has a
  clear retrieval need yet, and every tool in a prompt costs attention.
  Adding either later is a one-line `agent_tools` change + `db:seed`; the pm
  interview (org templates/house style informing project setup) is the first
  candidate if seeding quality suggests it.
