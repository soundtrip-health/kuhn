# Story 008-001: Suggestion mode for agent edits

**Status:** draft
**Epic:** [008 — Trust & the Writing Loop](../index.md)
**Estimate:** L

## Goal

Agent edits to draft documents should land as **pending suggestions** — diff
hunks the PI reviews and accepts or rejects — not as direct writes discovered
via a file badge. The `/write` command already proves the interaction (streamed
suggestion block, accept/reject); this story generalizes it to every
`write_file`/`edit_file` an agent makes against `draft/**`.

## Sketch

- Backend: a `pending_edits` table (project, path, base content hash, unified
  diff or full proposed content, agent, job, created_at). The runtime's
  `write_file`/`edit_file` tools route through it when the target matches the
  suggestion scope; other paths (`research/`, `pm/`, `guidance/`) keep direct
  writes. Tool result tells the agent its edit is "proposed, awaiting review"
  so it doesn't assume the content is live.
- Feed: a `file_change` variant (`kind: 'proposed'`) so the tree can badge
  "suggested changes" distinctly from applied ones.
- Webapp: opening a doc with pending edits renders the diff — reuse the
  `write-suggestion.ts` decoration pattern for in-place hunks. Accept applies
  the hunk through the normal save path (and logs the original agent/job in
  `file_events`); reject discards it. Accept-all / reject-all affordances.
- Staleness: if the doc changed since the suggestion's base hash, attempt a
  clean re-anchor; otherwise mark the suggestion stale and show it
  side-by-side instead of inline.

## Acceptance Criteria

- [ ] An agent edit to a `draft/**` document creates a pending suggestion;
      the file's stored bytes do not change until acceptance.
- [ ] The editor shows pending hunks inline with per-hunk accept/reject;
      acceptance writes through the normal save path and attributes the
      change to the originating agent/job in the activity log.
- [ ] Rejecting leaves the document untouched and informs nothing downstream
      (no file_change applied).
- [ ] Suggestions survive reload (server-stored) and appear on any tab.
- [ ] Agent-owned paths keep today's direct-write behavior.
- [ ] A stale suggestion (doc moved on) degrades to side-by-side review, never
      a corrupt merge.

## Notes

- Depends on 008-002 (version history) landing first as the safety net.
- Seeding is a deliberate exception: the skeleton pipeline writes the first
  draft directly (there is nothing to protect yet). Scope: post-seed edits.
- The org-eval story: this is the feature that turns "an AI edited my
  manuscript" into "I approved these changes" — surface it in
  `docs/data-pipeline.md` §model-involvement once shipped.
