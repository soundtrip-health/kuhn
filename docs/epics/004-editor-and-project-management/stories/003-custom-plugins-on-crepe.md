# Story 003: Custom plugins on Crepe

**Status:** done
**Epic:** [004 — Editor Upgrade + Project Management](../index.md)
**Estimate:** L

## Goal

Re-attach Kuhn's custom agent and citation surface to the Crepe editor and unify
the slash experience. This brings back citation chips, the `/cite` PubMed picker,
and the `/write` streamed accept/reject suggestion, and folds the agent-routed
slash commands into Crepe's one block-edit menu — retiring the bespoke
`slash.ts` caret-tracking plugin, which is the main source of the editor's
glitchiness.

## Acceptance Criteria

- [x] Citation chips render from `[@citekey]` and serialize back to markdown
      (port `citation.ts` `citationPlugins` onto `crepe.editor`); hover tooltips
      resolve from `references.bib` (`installCitationTooltips` / `bib.ts`).
- [x] `/cite` opens the PubMed picker (`cite-picker.ts`), inserts a chip,
      upserts `references.bib`, and refreshes the bib + file tree.
- [x] `/write` runs the Writer agent and streams an in-document suggestion with
      accept/reject (`write-suggestion.ts`); accept parses via the live parser
      (`markdownToSlice`) and the writer session persists for in-editor
      follow-ups.
- [x] All seven agent commands (`/cite`, `/write`, `/research`, `/figure`,
      `/review`, `/ask`, `/status`) are reachable from a single slash menu —
      preferably a custom group inside Crepe's BlockEdit menu via its
      `buildMenu` / feature config — alongside Crepe's native block options.
- [x] The old `slash.ts` plugin and its caret-positioning bug are removed (or
      explicitly reduced to a thin adapter if Crepe's menu can't host async
      agent actions — document the reason).
- [x] `cd webapp && npm run build` is clean.

## Notes

- Sources to re-mount: `editor.ts:90-149` (slash command registry, `/cite` +
  `/write` wiring), `citation.ts` (`citationPlugins`, `installCitationTooltips`,
  `insertCitation`), `cite-picker.ts`, `write-suggestion.ts`, `bib.ts`.
- Key open question: whether Crepe's BlockEdit menu can host commands that open a
  picker popover (`/cite`) or trigger a streaming agent task (`/write`), or
  whether those need a parallel trigger. Prefer one unified `/` menu; fall back
  to a custom Crepe slash group that dispatches to the existing handlers.
- `write-suggestion.ts` uses ProseMirror decorations on the view — confirm those
  still attach cleanly to `crepe.editor`'s view, and that Crepe's own plugins
  don't conflict with the decoration set.
- Citation node schema (`view.state.schema.nodes.citation`) must be registered
  on Crepe's schema — verify the node is present after `create()`.
- Depends on Story 001 (Crepe shell). Coordinate with Story 002 so collab and
  the citation node schema agree.

## Delivery

Custom surface re-mounted on `crepe.editor` as part of the bundled editor PR
(branch `epic-004-crepe-editor`).

- `citationPlugins` and `writeSuggestionPlugin` attach via a custom Crepe
  feature; the `citation` node + remark transform register on Crepe's schema.
- The seven agent commands fold into Crepe's BlockEdit menu as one "AI commands"
  group via `buildMenu` — a single `/` menu alongside Crepe's native block
  options. Each item's `onRun` removes the typed `/...` run then dispatches the
  existing handler (`/cite` picker, `/write` suggestion, routed toasts).
- `slash.ts` is deleted and its caret-tracking bug removed. Note: Crepe's menu
  is Notion-style — it opens only when the block text starts with `/` (not after
  arbitrary mid-block whitespace as `slash.ts` did); this is an accepted change.
- Verified: `cite-check.mjs` (slash → PubMed picker → chip → serialize → reload
  → tooltip) and `write-check.mjs` (stream → accept/reject/esc → error+retry, no
  doc leak) both pass on Crepe.
