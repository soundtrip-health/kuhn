# Story 004: Editor parity & glitch sweep

**Status:** ready
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** S

## Goal

Close out the editor migration with a QA pass against the "sparse and glitchy"
baseline that motivated the epic. Confirm Crepe resolves the known rough edges,
verify feature parity across the markdown surface, and capture any residual
issues as owning follow-up stories per the epic issue-audit rules.

## Acceptance Criteria

- [ ] A written checklist enumerates the prior glitches (e.g. slash-menu caret
      positioning, missing toolbar, no block/image/table affordances) and marks
      each resolved by Crepe or filed as a follow-up.
- [ ] Verified working in the running app: headings, bold/italic/strikethrough,
      ordered/bullet/task lists, tables, fenced code blocks (with language
      selection), inline + block math, links + link tooltip, images, blockquote,
      paste (incl. markdown paste), and undo/redo.
- [ ] Autosave, Cmd/Ctrl+S, word count, empty-state hero, and PDF preview/export
      still work end to end.
- [ ] Collaboration (Story 002) and `/cite` + `/write` (Story 003) verified once
      more in the integrated editor.
- [ ] Editor layout holds at narrow widths / the document measure is preserved.
- [ ] `editor.ts` header comments and any `docs/design/handoff/` notes are
      updated to reflect the Crepe architecture.
- [ ] Every residual issue has an owning open story listed in the epic table
      (self-contained and actionable).

## Notes

- This is a verification + cleanup story; no major new code. It exists so the
  Phase 1 migration is "done" under the repo's story-lifecycle rules (issue
  audit before marking done).
- Pair with the `/verify` or `/run` flow to drive the app and observe behavior
  rather than asserting parity from code alone.
