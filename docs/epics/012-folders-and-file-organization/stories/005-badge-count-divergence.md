# Story 012-005: Badge-count divergence & path-error mapping

**Status:** done
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

- [x] The collapsed-folder rollup and the `#toggle-files` pill agree for every
      case, including a pending proposal for a file that does not exist yet;
      whichever semantics is chosen is recorded here and in 012-001.
- [x] `ENOTDIR` from an ancestor-is-a-file path maps to a `conflict` StorageError
      (409) with a message naming the blocking file, for mkdir, read and write.
- [x] Colocated tests for both, including the `draft/main.md/sub` case.

## What shipped (2026-08-03)

### 1. Badge semantics: proposals roll up (option 1, as recommended)

`rollup()` (tree-state.ts) takes the phantom paths — `suggestMap` keys with
no tree node, i.e. `base_missing` proposals to *create* a file — as a third
argument and counts the ones beneath the folder into `unseen`, reported
separately as `phantoms`. `files.ts` supplies them via `phantomProposals()`.
The story's concrete case now agrees: an agent proposing a new
`draft/methods.md` shows pill = 1 and collapsed-`draft/` rollup = 1.

One wrinkle the spec didn't anticipate: rollup badges hide when a folder is
**open** (its children carry their own badges) — but a phantom has no row, so
an open folder would hide the proposal entirely. An open folder therefore
shows a dedicated `.is-phantom` badge (suggest-tinted) counting just the
phantoms beneath it, with the count in the row's accessible name ("N proposed
new files"). Phantoms never inflate the "N items" file count — a proposal is
not a file on disk.

Residual, accepted: a phantom whose *entire ancestor chain* is missing (the
proposal's would-be folder does not exist either) has no folder row to badge
— only the pill counts it. Unreachable through the normal flow, since agent
proposals are gated to `draft/`.

Tests: `webapp/src/tree-state.test.ts` (5 cases, incl. the pill-agreement
property and lookalike prefixes) on the vitest harness 012-004 stood up.
Live: `npm run phantom-check` (new token-free script) seeds a real
`base_missing` pending edit and asserts pill, open-folder phantom badge,
collapsed rollup, agreement, and no double-badging.

### Bonus: a latent 012-002 gap, caught by the final sweep

Running `files-check` live for the first time (it was written in 012-001 but
only `tree-check` had been run) exposed a missing leg in the move pre-flight:
`findPendingEditConflicts` walked pending edits under the *source* and
checked their re-keyed paths, so a **clean source moving onto a waiting
proposal** sailed through with a 200 — the arriving bytes would silently
become the proposal's base. The destination-side walk is now included (rows
being re-keyed by the same move excluded), with a colocated test
(`move-paths.test.js`) and `files-check` green end-to-end.

### 2. `ENOTDIR` → 409 naming the blocking file

`realpathDeepestExisting` (storage.js) maps `ENOTDIR` to a `conflict`
StorageError — `"A file is in the way: draft/main.md"` — instead of
rethrowing bare into a 500. One mapping covers mkdir, read and write, since
all pass through `resolveSafe`. Error mapping only: the containment verdict
is untouched, and the traversal/symlink tests guard that (a dedicated case
re-asserts both alongside the new conflict cases in `storage.test.js`).
Verified live: `POST /files/mkdir {"path":"draft/main.md/sub"}` → 409 with
the blocker named.

## Notes

- Fix 2 touches the tenancy-safety core (`resolveSafe` is what enforces the
  project root). Change only the error mapping — do not loosen containment, and
  keep the existing traversal/symlink tests green as the guard on that.
