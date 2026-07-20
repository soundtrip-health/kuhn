# Story 039: Raw markdown ("Source") mode in the editor

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Crepe is WYSIWYG-only: markdown the rich view hides or normalizes — a broken
image link, raw HTML comments, malformed tables — is unreachable. Give the
editor a **Source** toggle that shows and edits the raw markdown bytes in
storage, then returns to rich editing.

## Design decisions

- **Where:** a `Source` / `Rich text` toggle chip in the editor subheader
  (`#editor-mode-toggle`), visible whenever a document is open,
  `aria-pressed` reflects the mode.
- **What it shows:** the **stored bytes** (`readTextFile`), not the rich
  serialization — source mode exists precisely to reach what WYSIWYG
  normalizes. (Caveat: once the rich editor has autosaved a doc, storage
  already holds Crepe's serialization; source mode shows disk truth either
  way.)
- **Editor component:** CodeMirror 6 (`@codemirror/view/state/commands/
  lang-markdown/language`) — already in the dependency tree via Crepe's
  code-block feature, now direct dependencies. Markdown highlighting, history,
  line wrapping, `indentWithTab`; styled to the document measure in
  `style.css` (`#editor.editor-source`).
- **Single-writer while in source mode:** entering tears down Crepe + the Yjs
  provider (after a flush) and edits go straight to storage through the same
  debounced save path (`scheduleSave` → `PUT`). Rich collab is not live in
  source mode — an intentional simplification; the alternative (mirroring raw
  keystrokes into the shared Y doc via reparse) fights the CRDT and normalizes
  the text underneath the user.
- **Returning to rich:** flush, then `openDocument(..., { preferStored: true })`
  — after the provider syncs, if a still-warm room replays content that differs
  from storage, the stored text is force-applied (`replaceAll`) and propagates
  to any peers via collab. Without this, a warm room would resurrect the
  pre-source-edit content (same failure class as Story 038).
- External `file_change` events while in source mode: a clean source view is
  live-updated in place (same contract as the rich editor's
  `applyExternalChange`); a dirty one keeps the reload prompt.
- Save/word-count/status plumbing (`flushSave`, Cmd/Ctrl+S, `saved` chip,
  `#editor-wordcount`) works identically in both modes.

## Acceptance Criteria

- [x] Toggle in the subheader switches rich ⇄ source on the open document;
      button label and `aria-pressed` track the mode.
- [x] Source view shows raw markdown (HTML comments, image syntax) with
      highlighting; edits autosave through the normal debounce path.
- [x] Edits made in source mode survive the return to rich mode, including
      with a warm Yjs room (verified live in Chrome, 2026-07-19: added a
      broken-image line in source, toggled back, line present as a fixable
      image block).
- [x] Cmd/Ctrl+S, word count, and the saved/dirty status chip work in source
      mode.
- [x] `npm run build` (tsc strict) passes.

## Notes / deferred

- **Non-markdown text files** (`.bib`, `.txt`, `.csv`, `.json`, `.typ`,
  `.tex`) still open read-only in the preview pane. Reusing this CodeMirror
  surface to make them editable is a natural follow-up — not filed yet;
  file it against this story if wanted.
- While in source mode the user does not receive live collaborator edits
  (single-writer by design). Peers' clean editors pick the changes up through
  the feed; collab-heavy edge cases live in Story 041.
- The empty-doc hero overlay can appear over an empty source view; cosmetic.
