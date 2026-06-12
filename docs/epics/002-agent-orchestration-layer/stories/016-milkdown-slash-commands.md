# Story 016: Slash Commands in Milkdown (`/cite` Port)

**Status:** done
**Completed:** 2026-06-12
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Build the slash-command plugin for the Milkdown editor and port `/cite` (Epic 003's grounded
citation workflow) from the TeXlyre fork. This is the pattern every later command (`/write`,
`/review`, `/figure`) follows.

## Acceptance Criteria

- [x] Slash-command plugin: typing `/` at a block or after whitespace opens a command menu
      (ProseMirror suggestion pattern); filterable; extensible command registry on the frontend
- [x] `/cite <query>`: opens the citation picker, queries the backend citation service
      (PubMed-grounded, ported from Epic 003), shows candidates with title/authors/year/journal
- [x] Selecting a candidate inserts `[@citekey]` at the cursor and upserts the entry into the
      project's `references.bib` via the storage API
- [x] Citation keys render as styled inline chips in WYSIWYG mode (hover shows the reference);
      plain `[@citekey]` in the markdown source
- [x] Duplicate handling: citing an already-cited work reuses the existing key
- [x] Errors surface in the picker (rate limits, no results) without breaking the editor

## What Was Built

**Backend** (`agent-backend`):

- `src/citations.js` — citation service: PubMed search (`searchCitations`), MEDLINE/nbib
  record fetch + parse (`fetchPubmedRecord`/`parseNbib`), BibTeX generation
  (`formatBibEntry`), citekey generation `lastname+year` with `a/b/…` disambiguation
  (`makeCitekey`), and dedup-aware upsert into the project bibliography
  (`upsertCitation` → default `draft/references.bib`, via the story-018 storage API).
  Dedup matches PMID or DOI; re-citing returns the existing key without touching PubMed.
  All E-utilities calls are rate-limited (350 ms spacing) with retry/backoff on HTTP 429.
  Every BibTeX field comes from PubMed metadata — nothing model-generated (Epic 003
  grounding rule).
- `src/routes/citations.js` — `GET /api/projects/:id/citations/search?q=` and
  `POST /api/projects/:id/citations {pmid}` (201 created / 200 reused; upstream NCBI
  failures map to 502).
- `add_citation` agent tool (granted to **ra** and **writer**, seeded in `db/seed.js`):
  same upsert path, and it emits the `citation` AgentEvent
  (`{type:'citation', agent, key, bibtex, path}`) that story 011 had defined but never
  emitted — the chat shows "📚 ra added citation [@key]" and the webapp refreshes the
  file tree and bib cache live.

**Webapp**:

- `src/slash.ts` — slash-command plugin on `slashFactory` with an extensible
  `SlashCommand[]` registry; menu opens on `/` at block start or after whitespace,
  filters as you type, full keyboard support (↑↓/Enter/Tab/Esc). Visibility and
  caret-anchored positioning are handled directly in the plugin view — milkdown's
  `SlashProvider` was evaluated and dropped (see Notes).
- `src/cite-picker.ts` — floating picker: debounced PubMed search, candidate list
  (title/authors/journal/year), keyboard + click selection, inline error/empty states,
  aborts stale requests.
- `src/citation.ts` — citation chips: a remark transform splits `[@key]` text into
  custom `citation` mdast nodes (so chips render on document load), an mdast-to-markdown
  handler serializes them back to plain `[@key]` (a text node would get `\[`-escaped),
  and an inline atom ProseMirror node renders the chip. Hover tooltips resolve the key
  against `src/bib.ts` (a small bib cache refreshed on open and on `.bib` file changes).

**Verification**: `agent-backend npm test` (14 new unit tests: nbib parsing, citekey,
BibTeX rendering, upsert/dedup); `node webapp/scripts/cite-check.mjs` (Playwright,
intercepted citation endpoints — slash menu → picker → chip → markdown round-trip →
reload re-parse → tooltip; no PubMed network or LLM tokens needed); live route check
against PubMed (search + add + dedup-reuse).

## Notes

- **`SlashProvider` is not used.** Its debounced update compares against the previous
  editor state; with the collab plugin dispatching follow-up transactions after each
  keystroke, the debounce coalesces to a no-op (`isSame`) and the menu never opens.
  The plugin view computes match/visibility/position per transaction instead — also
  removes the 200 ms open latency.
- Multi-citation syntax (`[@a; @b]`) parses as separate chips only if written as
  separate `[@a] [@b]` tokens; Pandoc-style semicolon groups are untouched plain text
  for now (fine for Typst/Pandoc rendering, story 019).

## Known Issues (forward pointers only)

- Reloading the webapp against a warm Yjs room throws a `Context "editorState" not
  found` console error from the collab plugin (pre-exists this story; reproduced on
  main with no story-016 code). Deferred to **Story 024**.
- `texlyre/` directory removal now unblocked — owned by **Story 023**.

## Out of Scope

- `/write` and the writer agent (story 017)
- Bibliography rendering in PDF output (story 019 — Typst handles it from `.bib`)
