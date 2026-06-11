# Story 016: Slash Commands in Milkdown (`/cite` Port)

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Build the slash-command plugin for the Milkdown editor and port `/cite` (Epic 003's grounded
citation workflow) from the TeXlyre fork. This is the pattern every later command (`/write`,
`/review`, `/figure`) follows.

## Acceptance Criteria

- [ ] Slash-command plugin: typing `/` at a block or after whitespace opens a command menu
      (ProseMirror suggestion pattern); filterable; extensible command registry on the frontend
- [ ] `/cite <query>`: opens the citation picker, queries the backend citation service
      (PubMed-grounded, ported from Epic 003), shows candidates with title/authors/year/journal
- [ ] Selecting a candidate inserts `[@citekey]` at the cursor and upserts the entry into the
      project's `references.bib` via the storage API
- [ ] Citation keys render as styled inline chips in WYSIWYG mode (hover shows the reference);
      plain `[@citekey]` in the markdown source
- [ ] Duplicate handling: citing an already-cited work reuses the existing key
- [ ] Errors surface in the picker (rate limits, no results) without breaking the editor

## Technical Notes

- Backend: Epic 003's citation logic (PubMed search, BibTeX generation, Semantic Scholar rate
  limiter recommendation from the eval) moves/ports into `agent-backend` as a service endpoint —
  it is mostly editor-agnostic already.
- Frontend reference: `texlyre/` fork's `/cite` UI for UX only; reimplement (AGPL — no code
  reuse).
- Milkdown: use `@milkdown/plugin-slash` (or current equivalent) for the menu; a small remark
  extension or node view for the `[@citekey]` chips.
- Once this story is done, schedule removal of the `texlyre/` directory.
- Deferred from story 011: the runtime's `citation` AgentEvent is defined but never
  emitted. When the citation service lands here, emit `{ type: 'citation', key, bibtex }`
  from agent-driven citation insertions (e.g. the RA adding to `references.bib`) so the
  editor can react live.

## Out of Scope

- `/write` and the writer agent (story 017)
- Bibliography rendering in PDF output (story 019 — Typst handles it from `.bib`)
