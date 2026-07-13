# Story 006: "What Kuhn knows about you" panel

**Status:** ready
**Epic:** [007 — Identity & User Memory](../index.md)
**Estimate:** M

## Goal

Make memory transparent and correctable. A panel where the user sees every
active memory, edits or deletes any of them, and pauses the system entirely.
This is a trust requirement for a professional writing tool — and the
correction loop that keeps memory accurate is a feature, not a compliance
checkbox.

## Acceptance Criteria

- [ ] REST: `GET /api/me/memories` (active + archived, own user only),
      `PATCH /api/me/memories/:id` (edit content — resets confidence to
      user-asserted max; pause/unpause single memory), `DELETE` (hard
      delete), `POST /api/me/memories/pause` (global pause toggle stored on
      the user). All strictly scoped to the session user — no admin
      cross-user access.
- [ ] Panel UI reachable from the breadcrumb org/user menu ("What Kuhn knows
      about you"): memories grouped by kind with plain-language kind labels,
      each showing content, when learned/last reinforced, and — where
      recorded by Story 005 — "used in a recent session" indication. Edit
      in place, delete with undo-toast (not `window.confirm`), global pause
      switch with a clear explanation of the effect.
- [ ] User-edited memories are marked user-asserted: the distiller (004) may
      reinforce but never rewrite or auto-archive them; contradictions
      surface as a new suggested memory rather than silently replacing an
      asserted one.
- [ ] Empty state explains what memory is, what gets stored (small
      preferences/style facts, never document content), and that it's
      per-user and editable — set expectations before the first fact ever
      appears.
- [ ] Dialog/overlay follows the a11y pattern established in Epic 005
      story 004 (focus trap, `aria-modal`, Escape, focus restore).
- [ ] Vitest (routes) + a token-free webapp check: list → edit → delete →
      pause round-trip; cross-user access rejected.

## Notes

- Files: new `routes/me.js` (or extend an existing user-scoped route file),
  `db/user-memories.js`, new `webapp/src/memory-panel.ts`, `breadcrumb.ts`
  (menu entry), `api.ts`, `style.css`.
- Copy tone: matter-of-fact, not legalistic. One sentence of what/why beats a
  privacy-policy wall.
- Org-level shared memory (house style) is deferred; the panel's grouping
  should not preclude an "Organization" group appearing later.
