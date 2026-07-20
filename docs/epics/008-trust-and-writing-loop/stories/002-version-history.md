# Story 008-002: Document version history

**Status:** draft
**Epic:** [008 — Trust & the Writing Loop](../index.md)
**Estimate:** L

## Goal

Every state of every project document is recoverable: a timeline per document
(and per project), diffs between versions, one-click restore. This is the
safety net under agent edits and collaborative editing — and it closes the
"no backups, no soft delete" gap `docs/data-pipeline.md` currently has to
disclose to evaluating orgs.

## Sketch

- **Mechanism: a git repository per project directory** (already on Epic 002's
  deferred list). The backend commits on a debounced schedule — coalesce
  autosaves (e.g. at most one commit per few minutes of continuous editing)
  plus a labeled commit at every agent-job boundary and every explicit
  Cmd/Ctrl+S. Commits attribute user vs agent (author string from
  `file_events` semantics).
- `storage.js` must hide `.git` from `listProjectTree` and refuse it as a
  path segment (extend the existing traversal guards) — the tree stays clean
  and agents can't touch history.
- Routes: history list per path, diff between two versions, restore (which is
  itself a new commit — history is append-only, restore never rewrites).
- Webapp: a History panel on the open document (timeline grouped by
  day/job), diff view (reuse the CodeMirror surface from story 039's source
  mode with a merge/diff extension), restore button.
- Deleting a project deletes its repo with it (same directory).

## Acceptance Criteria

- [ ] Every save is reachable: continuous typing coalesces, but no committed
      state is ever lost once the debounce window closes.
- [ ] Agent job boundaries produce labeled versions ("Writer — draft full
      body, job 42") distinct from user edit checkpoints.
- [ ] Timeline + diff + restore in the UI for the open document; restore is
      append-only (a new version, not a rewrite).
- [ ] `.git` is invisible to the file tree, the storage API, and agent file
      tools.
- [ ] Works fully offline/local — no remote, no GitHub dependency.
- [ ] `docs/data-pipeline.md` retention section updated: point-in-time
      recovery now exists; state what it does and doesn't cover.

## Notes

- Git also quietly provides export ("clone your project") and a future sync
  surface, but both are out of scope here.
- Binary uploads (PDFs, images) are committed too — cheap at project scale;
  revisit only if repos bloat.
- Interplay with Yjs: storage remains the persistence layer (story 013
  model); history commits what storage sees. Live CRDT state is 010-002's
  concern.
