# Story 003: `search_org_knowledge` agent tool

**Status:** ready
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** M

## Goal

Let agents consult the org library. A read-only MCP tool that searches the
FTS index and returns passages with provenance, allowlisted per agent via the
existing `agent_tools` matrix — the one sanctioned crossing of the
project-root boundary. Updates the advisor/RA prompts so the advisor's
"knowledge base grows across projects" promise is finally backed by a real
mechanism.

## Acceptance Criteria

- [ ] New in-process MCP tool in `agents/runtime.js` `buildMcpTools`:
      `search_org_knowledge(query, limit?)` → ranked passages, each with
      `{ title, filename, headingPath, snippet }` and an explicit provenance
      line (document + section) so agents can cite what they relied on.
      Read-only; resolves the org from the project the task runs in.
- [ ] Tool definition added to `db/seed-data.js` and assigned in the
      agent→tool matrix to **advisor, ra, reviewer, writer** (pm/analyst
      excluded — see Notes); `npm run db:seed` applies it.
- [ ] Prompt updates (`db/prompts/advisor.md`, `ra.md`, and where relevant
      `reviewer.md`/`writer.md`): when org guidance may exist, search it
      before answering style/process/regulatory questions, and cite the
      source document by name. Advisor's cross-project knowledge language is
      revised to describe the org library accurately.
- [ ] Empty-library behavior is graceful: the tool returns a clear
      "no org library documents yet" result (not an error), and prompts don't
      induce retry loops on it.
- [ ] Relevance eval: with `guidance-docs/` imported into a test org
      (Story 002 fixture), a scripted check runs ~10 representative queries
      and asserts the expected document appears in the top 3. Token-free
      (direct function/tool-layer calls, no model). Record results in this
      story on completion; they are the evidence for/against a future
      embeddings story.
- [ ] Vitest coverage: tool respects the allowlist (agent without assignment
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
