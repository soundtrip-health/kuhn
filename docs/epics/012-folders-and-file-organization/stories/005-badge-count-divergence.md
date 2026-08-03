# Story 012-005: Badge-count divergence & path-error mapping

**Status:** ready
**Epic:** [012 — Folders & File Organization](../index.md)
**Estimate:** S

## Goal

Two small, unrelated correctness gaps surfaced by [012-001](001-folder-tree-ui.md)
that were out of scope for it. Grouped because both are one-sitting fixes in the
same area (paths and their counts) and neither justifies its own story.

## 1. The folder rollup and the unseen pill count different things

`012-001` rolls a collapsed folder's badges up as **the sum of flagged
descendant tree nodes**. `updateUnseenPill` counts the union of statusMap-flagged
paths and **all** `suggestMap` keys. A pending edit may name a path with no file
on disk (`pending_edits.base_missing` — the row is a proposal to *create* a
file), so it has no tree node and cannot be rolled up.

Concretely: an agent proposes a new `draft/methods.md`. The header pill counts
it; collapsing `draft/` shows a rollup one lower. Neither number is wrong for
what it measures — they just disagree, visibly, on the same screen.

Decide which is the truth and make both report it:
- roll proposals up to their would-be parent folder (needs the rollup to walk
  `suggestMap` keys as well as tree nodes), or
- exclude file-less proposals from the pill so both count real files, and
  surface proposals separately.

The first is probably right — a proposed new file is exactly the thing a user
should not miss behind a collapsed folder — but it means the rollup can no
longer be a pure fold over the tree.

## 2. A file in the middle of a path is a 500

`resolveSafe` → `realpathDeepestExisting` (`agent-backend/src/storage.js:116-132`)
tolerates only `ENOENT`. When an **ancestor** of the requested path is a file,
`realpath()` fails `ENOTDIR`, which is rethrown bare and mapped to a generic
500 by the route error handler.

So `POST /files/mkdir` with `draft/main.md/sub` — a plausible typo, and now
reachable from the folder UI — returns "Internal error" instead of a 409
saying a file is in the way. Pre-existing and shared with `readProjectFile`
and `writeProjectFile`; it was not introduced by 012-001 and was left alone
there because the fix is in the shared containment core.

## Acceptance Criteria

- [ ] The collapsed-folder rollup and the `#toggle-files` pill agree for every
      case, including a pending proposal for a file that does not exist yet;
      whichever semantics is chosen is recorded here and in 012-001.
- [ ] `ENOTDIR` from an ancestor-is-a-file path maps to a `conflict` StorageError
      (409) with a message naming the blocking file, for mkdir, read and write.
- [ ] Colocated tests for both, including the `draft/main.md/sub` case.

## Notes

- Fix 2 touches the tenancy-safety core (`resolveSafe` is what enforces the
  project root). Change only the error mapping — do not loosen containment, and
  keep the existing traversal/symlink tests green as the guard on that.
