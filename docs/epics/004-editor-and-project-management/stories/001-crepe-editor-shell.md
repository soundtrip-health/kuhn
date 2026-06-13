# Story 001: Crepe editor shell

**Status:** done
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** L

## Goal

Replace the hand-rolled Milkdown build in `webapp/src/editor.ts` with a
**Milkdown Crepe** editor (via `CrepeBuilder`), bringing in the Notion-style
feature set out of the box: formatting toolbar, block-edit slash menu, block
handle, image block, table, CodeMirror code blocks, link tooltip, list items,
placeholder, LaTeX, and cursor. Preserve every behavior currently wired around
the editor, and theme Crepe to match the story-025 "Column" design.

This story stands up the shell only. Collaboration (Story 002) and the custom
agent/citation surface (Story 003) are layered on top afterward; build the shell
so `crepe.editor` (the underlying Milkdown `Editor`) is reachable for those.

## Acceptance Criteria

- [x] `editor.ts` instantiates the editor with `CrepeBuilder` from
      `@milkdown/crepe/builder`, adding tree-shaken features: toolbar,
      block-edit, image-block, table, code-mirror, list-item, link-tooltip,
      placeholder, latex, cursor.
- [x] Crepe is themed to match "Column": start from a Crepe theme, override with
      `kuhn-tokens.css` values; the Nord theme import (`@milkdown/theme-nord`)
      and its CSS are removed with no visual remnants.
- [x] `openDocument` / `closeDocument` still load from and tear down the storage
      API correctly; `applyExternalChange` still works using `getMarkdown` /
      `replaceAll` against `crepe.editor`.
- [x] Debounced (1500 ms) autosave and Cmd/Ctrl+S flush through the storage API
      are intact; the `markdownUpdated` save guard (`prev != null && markdown !==
      prev`) still prevents spurious saves.
- [x] Word count (`updateDocMeta` → `#editor-wordcount`) and the empty-state
      hero toggle (`#editor-hero`) update on document change as before.
- [x] Toolbar (bold/italic/etc.), block handle, image block, table, and code
      blocks are usable in the running app.
- [x] `cd webapp && npm run build` is clean (tsc + vite).

## Notes

- Current build to replace: `editor.ts:186-206` (`Editor.make().config(nord)…
  .use(commonmark).use(gfm).use(math)…`). Crepe bundles commonmark/gfm/math
  equivalents, so those `.use()` calls go away; the custom `.use()` calls
  (citation, slash, write-suggestion) move to Story 003.
- Crepe exposes the underlying editor as `crepe.editor` — that's the handle
  Stories 002/003 attach collab and custom plugins to. Confirm the builder's
  `create()` returns it.
- Reuse, don't rewrite: `scheduleSave` / `doSave` / `flushSave` /
  `cancelPendingSave` / `discardDocument` and the `updateDocMeta` helper should
  carry over unchanged; only the editor-construction block changes.
- Package: add `@milkdown/crepe`; keep `@milkdown/kit` (Crepe builds on it). Drop
  `@milkdown/theme-nord` once theming is reconciled.
- Theme reconciliation is the main unknown — Crepe ships `crepe`, `nord`, and
  `frame` themes (light/dark). Pick the closest base and override tokens; budget
  time for CSS specificity fights with `style.css`.
- Editor measure/typography (Source Serif 4 body, `--doc-measure`) must be
  preserved; Crepe's content styles may need overriding to match.

## Delivery

Delivered together with Stories 002 and 003 in one editor PR (branch
`epic-004-crepe-editor`) — all three rewrite `editor.ts`, so they were bundled
to avoid churning the file three times and leaving the app without collab /
citations between steps.

- `editor.ts` now builds the editor with `CrepeBuilder` + tree-shaken features
  (toolbar, block-edit, image-block, table, code-mirror, list-item,
  link-tooltip, placeholder, latex, cursor). `@milkdown/plugin-math` is dropped
  (Crepe's `latex` feature replaces it).
- Themed to Column by mapping the `--crepe-*` variables onto Column tokens in
  `style.css` (no Crepe color theme imported, so no Nord/classic remnants);
  `@milkdown/theme-nord` removed. The global `:focus-visible` ring is suppressed
  on the document canvas; Crepe's floating popovers use the Column pop shadow.
- Save / word-count / hero / `applyExternalChange` logic carried over unchanged
  against `crepe.editor`.
- Verified: `npm run build` clean; `editor-check.mjs` (shell + unified slash
  menu), `smoke.mjs` (render + autosave), and an h1/bold/italic render check.
