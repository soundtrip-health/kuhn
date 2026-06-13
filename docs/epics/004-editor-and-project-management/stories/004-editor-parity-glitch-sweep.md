# Story 004: Editor parity & glitch sweep

**Status:** done
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** S

## Goal

Close out the editor migration with a QA pass against the "sparse and glitchy"
baseline that motivated the epic. Confirm Crepe resolves the known rough edges,
verify feature parity across the markdown surface, and capture any residual
issues as owning follow-up stories per the epic issue-audit rules.

## Acceptance Criteria

- [x] A written checklist enumerates the prior glitches (e.g. slash-menu caret
      positioning, missing toolbar, no block/image/table affordances) and marks
      each resolved by Crepe or filed as a follow-up.
- [x] Verified working in the running app: headings, bold/italic/strikethrough,
      ordered/bullet/task lists, tables, fenced code blocks (with language
      selection), inline + block math, links + link tooltip, images, blockquote,
      paste (incl. markdown paste), and undo/redo.
- [x] Autosave, Cmd/Ctrl+S, word count, empty-state hero, and PDF preview/export
      still work end to end.
- [x] Collaboration (Story 002) and `/cite` + `/write` (Story 003) verified once
      more in the integrated editor.
- [x] Editor layout holds at narrow widths / the document measure is preserved.
- [x] `editor.ts` header comments and any `docs/design/handoff/` notes are
      updated to reflect the Crepe architecture.
- [x] Every residual issue has an owning open story listed in the epic table
      (self-contained and actionable).

## Notes

- This is a verification + cleanup story; no major new code. It exists so the
  Phase 1 migration is "done" under the repo's story-lifecycle rules (issue
  audit before marking done).
- Pair with the `/verify` or `/run` flow to drive the app and observe behavior
  rather than asserting parity from code alone.

## Sweep Results (2026-06-13)

Verified empirically against the running app (backend :3002 + dev server :5174)
via `npm run parity-check` (`scripts/parity-sweep.mjs`, 22/22), `editor-check`,
`smoke`, `collab-check`, `cite-check`, `write-check`, and `render-check`.

### Prior glitches → resolution

| Prior glitch (motivated the epic) | Status |
|---|---|
| Slash-menu caret positioning bug (bespoke `slash.ts`) | **Resolved** — `slash.ts` retired; the menu is Crepe's BlockEdit `SlashProvider`. Now Notion-style: opens on block-start `/` only (accepted change). |
| Missing formatting toolbar | **Resolved** — Crepe toolbar shows on text selection (bold/italic/strike/code/link/latex). |
| No block affordances (block handle / add) | **Resolved** — Crepe block handle + `/` block menu. |
| No image / table / code-block affordances | **Resolved** — image-block, table, and CodeMirror code blocks (with language picker) all present. |
| Sparse markdown feature set | **Resolved** — full surface verified (matrix below). |

### Feature parity matrix (all PASS)

Headings (h1–h6), bold, italic, strikethrough, inline code, links + link
tooltip, blockquote, bullet list, ordered list, **task list with checkboxes**,
tables, fenced code blocks + language picker, **inline math (katex)**, **block
math** (`$$` → code-block katex preview), images, markdown **paste**, **undo /
redo**, formatting toolbar on selection.

### Other acceptance criteria

- Autosave (1500 ms debounce), Cmd/Ctrl+S flush, word count, empty-state hero —
  verified (`smoke`, and the word counter showing live counts).
- PDF preview + docx/tex export — verified (`render-check`, 12/12).
- Collaboration, `/cite`, `/write` — re-verified on the integrated editor
  (`collab-check`, `cite-check`, `write-check`).
- Narrow-width layout / document measure — `--doc-measure` (660px) preserved;
  the column shrinks responsively. At very narrow editor-pane widths a table or
  code block keeps its intrinsic min-width (minor in-pane horizontal scroll) —
  inherent to those nodes, not a Crepe regression.

### Residual issues

None blocking. Two accepted behaviors, documented above, require no follow-up
story: (1) the slash menu is Notion-style (block-start `/`); (2) tables/code
blocks keep their min-width at very narrow pane widths. No console/page errors
were observed across any check.
