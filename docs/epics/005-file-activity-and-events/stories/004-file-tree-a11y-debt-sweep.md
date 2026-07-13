# Story 004: File-tree a11y & UI debt sweep

**Status:** done
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Outcome

All acceptance criteria met (2026-07-12).

- **File tree**: `role="tree"`/`treeitem`/`group` structure, roving tabindex
  (exactly one tabbable item, focus-follows), `aria-selected` synced with the
  active row, `aria-expanded` on folder summaries (kept in sync via the
  `toggle` event), and Arrow/Home/End keyboard navigation (Right/Left
  expand/collapse or jump to the enclosing folder; Enter/Space activate
  natively — rows are buttons, folders summaries).
- **Badges announced, not colored**: badge visuals are `aria-hidden`; the
  status is spoken through the treeitem's accessible name ("main.md, new AI
  changes" / "modified since last viewed" / …). Folder counts and the Files
  toggle pill carry `aria-label`s.
- **Live regions**: `#status-notice` and `#topbar-activity` are
  `role="status" aria-live="polite"`; toasts already were. The save-state
  chip stays silent by design — per-keystroke churn is SR noise.
- **Overlays**: project browser is `role="dialog" aria-modal` with a focus
  trap (new `a11y.ts` `trapFocus`, list computed per keystroke so re-renders
  survive) and focus restore on close; the breadcrumb org menu is
  `role="menu"`/`menuitem` with ArrowUp/Down cycling, Escape-close, and
  focus restore to the trigger.
- **Debt**: `PROJECT_TYPES`/`TYPE_LABEL` deduplicated into
  `project-types.ts`; hand-rolled escaper replaced with platform
  `CSS.escape`; project browser gained loading and retryable error states
  backed by new `workspace.projectsLoading()/projectsError()/
  reloadProjects()` (fetch failures no longer reject unhandled from the org
  switch); chat restore failures surface as a non-blocking notice instead of
  a silent catch.
- **Documented exceptions**: delete keeps native `window.confirm()`
  (keyboard/SR-accessible by construction; noted in code); org creation
  keeps `window.prompt` with a pointer to Epic 006 story 004's modal.

Verified: `tsc && vite build` clean; `files-check` (19/19) and
`editor-check` pass; a live 16-assertion Playwright a11y probe (tree roles,
roving tabindex, ArrowDown/Home movement, aria-expanded/selected, live
regions, dialog trap + focus restore, menu semantics + Escape restore) — all
ok.

## Goal

Bring the file tree up to basic accessibility standards and clear a short list
of known webapp debt items surfaced in the 2026-07-12 review, so the file
manager work in this epic lands on a clean base.

## Acceptance Criteria

- [x] File tree a11y: `role="tree"`/`treeitem"`/`group` structure,
      `aria-selected` on the active row, `aria-expanded` on folders, and
      arrow-key/Home/End/Enter keyboard navigation. Rename inputs and delete
      confirmation are reachable and announced (no bare `window.confirm` if a
      styled confirm is introduced; otherwise document the exception).
- [x] Unseen badges/counts have text equivalents (`aria-label`, not
      color/dot-only).
- [x] Status bar and toasts become `aria-live="polite"` regions
      (`webapp/src/status.ts`, `toast.ts`).
- [x] Overlays get dialog semantics: `role="dialog"`, `aria-modal`, focus trap
      on open, focus restore on close (`project-browser.ts` `.pb-overlay`,
      breadcrumb org menu).
- [x] Debt items:
      - Deduplicate `PROJECT_TYPES`/`TYPE_LABEL` (copies in
        `project-browser.ts:11-20` and `breadcrumb.ts:14-20`) into one module.
      - Replace hand-rolled `cssEscape` (`files.ts:510-512`) with `CSS.escape`.
      - Project browser gets a loading state and a visible error state for a
        failed project list fetch (`project-browser.ts:93-172`).
      - Chat restore no longer swallows errors silently (`chat.ts:112-115`) —
        surface a non-blocking notice.
- [x] `npm run build` (tsc) clean; existing check scripts pass.

## Notes

- Keyboard-accessible upload beyond the Upload button (i.e., a drag-and-drop
  alternative) is already satisfied by the button itself — no new work, just
  don't regress it.
- Scope guard: this is a sweep, not a redesign. Anything structural found
  along the way gets filed as a new story, not folded in.
