# Story 023: Remove the TeXlyre Fork

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Delete the retired `texlyre/` directory. The 2026-06-11 architecture revision kept it
in-tree only as a UX reference until the `/cite` port was done; story 016 completed that
port (slash menu, citation picker, chips, bibliography upsert — all reimplemented, no
AGPL code reused), so the fork has no remaining purpose.

## Acceptance Criteria

- [ ] `texlyre/` removed from the repo (git history preserves it if ever needed)
- [ ] No remaining references that imply it still exists: update the repo-layout tree in
      `CLAUDE.md`/`AGENTS.md`, the "Keep `texlyre/` in-tree until the `/cite` port is
      done" line in `docs/architecture.md`, and the TeXlyre `/cite` section of
      `TESTING.md` (mark historical or drop)
- [ ] `web-citation/` reviewed at the same time: its search-engine/RIS modules were the
      Epic 003 reference; decide keep (still referenced) or fold useful remainder into
      `agent-backend` and remove

## Notes

- The fork is AGPL — deleting it also removes the last AGPL code from the tree
  (strategy.md already assumes this).
