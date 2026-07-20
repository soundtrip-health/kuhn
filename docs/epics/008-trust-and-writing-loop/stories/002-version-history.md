# Story 008-002: Document version history

**Status:** done
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

- [x] Every save is reachable: continuous typing coalesces (trailing throttle,
      `KUHN_HISTORY_AUTOCOMMIT_MS`, default 2 min), and destructive actions
      (delete, overwriting upload, restore) snapshot the pre-state first so
      the window never loses it.
- [x] Agent job boundaries produce labeled versions ("writer finished
      (job 42)") distinct from user edit checkpoints — hooked at the
      `publishProjectEvent` choke point alongside the activity log.
- [x] Timeline + diff (CodeMirror `unifiedMergeView`) + restore in the UI for
      the open document; restore is append-only and live-updates a clean open
      editor through the existing `file_change` path. (Verified live in
      Chrome, 2026-07-19: two versions listed with authors, additions
      highlighted, restore returned the doc to v1 with commit
      "Restore hist-test.md to 5669808".)
- [x] `.git` is invisible to the file tree, the storage API, and agent file
      tools (`resolveWithin` rejects the segment; `walkTree` skips it).
- [x] Works fully offline/local — system `git` binary, no remote.
      `KUHN_HISTORY_ENABLED=false` for hosts without git.
- [x] `docs/data-pipeline.md` layout + retention sections updated.

## Notes

- Git also quietly provides export ("clone your project") and a future sync
  surface, but both are out of scope here.
- Binary uploads (PDFs, images) are committed too — cheap at project scale;
  revisit only if repos bloat.
- Interplay with Yjs: storage remains the persistence layer (story 013
  model); history commits what storage sees. Live CRDT state is 010-002's
  concern.
- **Design fix found in verification:** Cmd/Ctrl+S on an already-autosaved
  (clean) editor originally short-circuited before the request, so no
  checkpoint version was cut; an explicit save now writes through with
  `?checkpoint=1` regardless.
- **Deliberate coalescing limits (accepted):** agent overwrites within one
  auto-commit window collapse into that window's single commit (job-boundary
  commits bound the loss), and the seeding pipeline's writes are captured by
  the job-boundary commit, not per-file.
- **Incident during verification, owned by Story 010-002:** with two tabs
  holding the same doc across backend restarts (`node --watch`), the
  memory-only Yjs rooms died and the tabs' independently-seeded CRDTs merged
  on reconnect, duplicating the document (main.md doubled; repaired from the
  identical halves and committed as "Save draft/main.md"). Concrete repro
  recorded in 010-002 — server-side room persistence is the fix.
- UI is per-document history; the API already supports a project-wide
  timeline (`path` optional) if a later story wants a project view.
