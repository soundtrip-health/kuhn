# Story 008-005: Agent write coherence & deterministic reference tools

**Status:** done (2026-08-02)
**Epic:** [008 — Trust & the Writing Loop](../index.md)
**Estimate:** M
**Origin:** issues #42 (agent file writes "not persisting") and #41 (RA
hand-editing the bibliography instead of using deterministic tools) — the
2026-07-21 incident where the RA verified every reference correction but
couldn't land any of them.

## Root cause (as diagnosed)

There was never an approval gate blocking sub-agent writes (the runtime runs
`bypassPermissions`). The incident was three interacting design gaps:

1. `DEFAULT_BIB_PATH` (`draft/references.bib`) sits inside the suggestion-mode
   scope (008-001), so the RA's `write_file`/`edit_file` calls on the bib were
   silently diverted into pending edits ("awaiting user review").
2. `read_file` returned disk bytes, not the pending proposal — a write→read
   verify loop saw stale content and concluded the write was lost, so the
   agent thrashed (failed string edits, whole-file rewrites).
3. A pending edit on a `.bib` is invisible anyway: suggestion hunks render
   only in the Milkdown editor and non-md files open in preview (issue #44) —
   and the bib is *derived* from the SQLite reference store, so even an
   accepted hand edit would be clobbered at the next regeneration. There was
   also no deterministic tool to correct or delete an existing reference —
   `add_citation`/`add_reference` only add — which is why the RA resorted to
   hand-editing at all.

## As built

**Write coherence (#42, PR #49):**
- `read_file` on a path with a pending proposal returns the proposed content
  with an explicit banner note (`pendingProposalContent` in `pending-edits.js`).
- The suggestion-mode tool result states plainly that the write is COMPLETE
  and must not be retried.
- `write_file`/`edit_file` on a materialized bibliography are refused with an
  instructive error (`isDerivedBibPath` in `citations.js`) steering to the
  deterministic tools.

**Audit trail (#42, PR #49):**
- `messages.is_error` column records tool-result outcomes (nullable; column
  migration in `db/init.js`).
- `GET /api/agent/jobs/:id/trace` returns a job's full account — job row,
  conversation messages with tool calls/results and error flags, and
  recursively its sub-agent jobs (`getJobTrace` in `db/jobs.js`). This is the
  hook for proactively sampling agent runs, not just debugging reports.

**Deterministic reference lifecycle (#41):**
- `update_reference` (cite key + only the fields to fix; cite key immutable so
  in-text `[@key]` never breaks; DOI/PMID normalized; weak-id hash and
  identity_status recomputed) and `remove_reference` (delete by cite key;
  regenerates the bib even when it becomes empty) — runtime tools gated by a
  new `manage_references` tool slug, assigned to the RA.
- Service layer `updateReference`/`removeReference` in `citations.js` over
  `updateReferenceFields`/`deleteReference` in `db/references.js`.
- RA prompt rewritten where it caused the incident: the "save references to
  `draft/references.bib` in natbib format" instruction is replaced by a
  "Bibliography Maintenance — deterministic tools ONLY" section covering all
  four tools; in-text citation style corrected from `[Author, Year]` to the
  app's `[@key]`; "already exists" tool results documented as success.

## Acceptance criteria

- [x] An agent that writes to `draft/**` and reads the file back sees its own
      proposal, not stale disk bytes.
- [x] Direct agent writes to a materialized `.bib` are refused with guidance
      to the deterministic tools.
- [x] The RA can correct and delete existing references by cite key; the
      derived bib regenerates on every store change.
- [x] Tool-result errors are queryable (`messages.is_error`) and a full job
      trace (including sub-jobs) is one GET away.

## Deferred / follow-ups

- Non-md files opening in preview instead of the editor — owned by issue #44.
- Proactive log-review automation (sampling traces on a schedule) — the trace
  endpoint is the primitive; no owning story yet, tracked in issue #42's
  discussion if reopened.
- Broader RA prompt staleness (dead `read_sections.py` audit script, external
  MCP-servers section) — owned by Epic 002 story 035 (dead prompt
  instructions).
