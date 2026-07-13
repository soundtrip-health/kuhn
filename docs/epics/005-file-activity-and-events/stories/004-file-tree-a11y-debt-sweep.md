# Story 004: File-tree a11y & UI debt sweep

**Status:** ready
**Epic:** [005 — File Activity & Project Events](../index.md)
**Estimate:** M

## Goal

Bring the file tree up to basic accessibility standards and clear a short list
of known webapp debt items surfaced in the 2026-07-12 review, so the file
manager work in this epic lands on a clean base.

## Acceptance Criteria

- [ ] File tree a11y: `role="tree"`/`treeitem"`/`group` structure,
      `aria-selected` on the active row, `aria-expanded` on folders, and
      arrow-key/Home/End/Enter keyboard navigation. Rename inputs and delete
      confirmation are reachable and announced (no bare `window.confirm` if a
      styled confirm is introduced; otherwise document the exception).
- [ ] Unseen badges/counts have text equivalents (`aria-label`, not
      color/dot-only).
- [ ] Status bar and toasts become `aria-live="polite"` regions
      (`webapp/src/status.ts`, `toast.ts`).
- [ ] Overlays get dialog semantics: `role="dialog"`, `aria-modal`, focus trap
      on open, focus restore on close (`project-browser.ts` `.pb-overlay`,
      breadcrumb org menu).
- [ ] Debt items:
      - Deduplicate `PROJECT_TYPES`/`TYPE_LABEL` (copies in
        `project-browser.ts:11-20` and `breadcrumb.ts:14-20`) into one module.
      - Replace hand-rolled `cssEscape` (`files.ts:510-512`) with `CSS.escape`.
      - Project browser gets a loading state and a visible error state for a
        failed project list fetch (`project-browser.ts:93-172`).
      - Chat restore no longer swallows errors silently (`chat.ts:112-115`) —
        surface a non-blocking notice.
- [ ] `npm run build` (tsc) clean; existing check scripts pass.

## Notes

- Keyboard-accessible upload beyond the Upload button (i.e., a drag-and-drop
  alternative) is already satisfied by the button itself — no new work, just
  don't regress it.
- Scope guard: this is a sweep, not a redesign. Anything structural found
  along the way gets filed as a new story, not folded in.
