# Story 023: Remove the TeXlyre Fork

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Delete the retired `texlyre/` directory. The 2026-06-11 architecture revision kept it
in-tree only as a UX reference until the `/cite` port was done; story 016 completed that
port (slash menu, citation picker, chips, bibliography upsert — all reimplemented, no
AGPL code reused), so the fork has no remaining purpose.

## Acceptance Criteria

- [x] `texlyre/` removed from the repo (git history preserves it if ever needed)
- [x] No remaining references that imply it still exists: update the repo-layout tree in
      `CLAUDE.md`/`AGENTS.md`, the "Keep `texlyre/` in-tree until the `/cite` port is
      done" line in `docs/architecture.md`, and the TeXlyre `/cite` section of
      `TESTING.md` (mark historical or drop)
- [x] `web-citation/` reviewed at the same time: its search-engine/RIS modules were the
      Epic 003 reference; decide keep (still referenced) or fold useful remainder into
      `agent-backend` and remove

## Notes

- The fork is AGPL — deleting it also removes the last AGPL code from the tree
  (strategy.md already assumes this).

## Resolution (2026-06-12)

- `texlyre/` was **never tracked in this repo** (gitignored nested clone), so kuhn's git
  history does *not* preserve it — it is preserved on the fork's own remote instead:
  `soundtrip-health/texlyre`, branch `cite1`, fully pushed and clean at deletion time.
  The local copy was moved to `~/.Trash/texlyre-removed-story023` rather than hard-deleted.
  The `.gitignore` texlyre block was removed with it.
- `web-citation/` decision: **removed**. Nothing imports it — `agent-backend/src/citations.js`
  is a self-contained PubMed/BibTeX implementation, and Kuhn has no RIS surface. Its
  multi-provider engine (OpenAlex/Crossref/Semantic Scholar) is in git history if a future
  multi-source research story wants it.
- Docs updated: `AGENTS.md` repo tree (webapp/ added, texlyre/ dropped), `README.md`
  status + legacy section, `docs/architecture.md` Milkdown consequences,
  `TESTING.md` (story 009 Yjs checks reworded; Epic 003 TeXlyre checklist replaced
  with a historical pointer to `git show ca90441:TESTING.md`). Epic 001/003 story docs
  mention TeXlyre as historical record — left as-is per story lifecycle rules.
- Follow-up noted (not an issue): the y-webrtc signaling endpoint
  (`agent-backend/src/yjs-signaling.js`, `/yjs-signaling`) is now clientless — its only
  consumer was the fork. Kept because "own Yjs signaling + websocket servers" is a
  recorded architecture decision; revisit when multi-user collab is scoped.
