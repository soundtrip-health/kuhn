# Story 008-001: Suggestion mode for agent edits

**Status:** done
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

- [x] An agent edit to a `draft/**` document creates a pending suggestion;
      the file's stored bytes do not change until acceptance.
- [x] The editor shows pending hunks inline with per-hunk accept/reject;
      acceptance writes through the normal save path and attributes the
      change to the originating agent/job in the activity log.
- [x] Rejecting leaves the document untouched and informs nothing downstream
      (no file_change applied).
- [x] Suggestions survive reload (server-stored) and appear on any tab.
- [x] Agent-owned paths keep today's direct-write behavior.
- [x] A stale suggestion (doc moved on) degrades to side-by-side review, never
      a corrupt merge.

## Notes

- Depends on 008-002 (version history) landing first as the safety net.
- Seeding is a deliberate exception: the skeleton pipeline writes the first
  draft directly (there is nothing to protect yet). Scope: post-seed edits.
- The org-eval story: this is the feature that turns "an AI edited my
  manuscript" into "I approved these changes" — surfaced in
  `docs/data-pipeline.md` §2 (agent-writes row) at ship time.

## Implementation record (2026-07-19)

- **Model:** one coalesced `pending_edits` row per (project, path) storing full
  base + proposed blobs (`base_missing` for new files); hunks derived
  server-side with jsdiff (`structuredPatch`, context 2, per-hunk sha256 guard
  — accept/reject send `{index, hash}`, 409 on mismatch). No `'proposed'` kind
  in `file_events` (kept its CHECK constraint); suggestions live only in their
  own table until acceptance.
- **Backend:** `src/pending-edits.js` (service: scope matcher, hunk math,
  re-anchor, accept/reject), `src/db/pending-edits.js`, and
  `routes/pending-edits.js` (`GET /`, `POST /`, `POST /:id/accept`,
  `POST /:id/reject` under `/api/projects/:id/pending-edits`; `POST /` also
  powers the token-free check). Runtime gate in `write_file`/`edit_file`
  (leading-segment `draft` match); `edit_file` validates `old_string` against
  the *effective* content (existing proposal first) so sequential agent edits
  stay coherent; tool results say "proposed, awaiting review". Seeding bypass
  flag threaded like `compose` and inherited by `dispatch_agent` sub-tasks.
- **Accept path is server-driven:** apply → `writeProjectFile` → attributed
  `file_change` (activity log + Yjs room eviction) → labeled `commitNow`
  ("Accept suggestion on <path> (job <id>)"). Reject deletes/un-applies with
  no write, emitting only the SSE-only `kind: 'proposed'` invalidation (which
  `project-events.js` routes around the activity log, eviction, and history
  commit). A row whose proposed content comes to equal the disk file
  self-resolves on refresh.
- **Staleness:** on every read and before accept/reject, base-hash mismatch →
  re-anchor via `applyPatch` (fuzz 0); clean → rebase in place, else `stale: 1`
  → editor falls back to a side-by-side merge-view modal ("Replace document
  with proposed" = `force: true` accept, or discard). Never a client-side merge.
- **Webapp:** `suggestion-hunks.ts` (decoration plugin modeled on
  `write-suggestion.ts`, multi-hunk, position-remapped; header bar with
  accept-all/reject-all), `'suggested'` tree badge that survives opening the
  file and wins over `modified`, rehydrated from `GET /pending-edits` and
  refreshed (debounced) on any `file_change` event. Editor refresh after accept
  rides the existing external-change path — no new reload machinery.
- **Verification:** 49 new backend tests (297 total green); webapp
  `npm run suggestion-check` (token-free Playwright, modeled on write-check)
  exercises badge → inline hunks → per-hunk UI accept persisting server-side →
  reject leaving no trace, end-to-end against a live stack.
- Known rider, unchanged behavior: accepting into an open doc goes through the
  same Yjs room eviction as today's agent direct writes (story 038 lifecycle).
