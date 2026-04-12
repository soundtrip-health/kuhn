# Story 006: Implement grounded retrieval for `/cite`

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** XL

## Goal

Build the retrieval and ranking flow that turns a local claim into a short list of validated candidate citations.

## Acceptance Criteria

- [x] Extract the previous sentence or selected text as the citation target
- [x] Parse optional user hints from the `/cite` command input and combine them with local writing context
- [x] Generate one or more search queries for configured providers from context plus hints
- [x] Retrieve candidate results from providers and normalize metadata
- [x] Filter or reject results that fail validation or appear weakly related to the claim
- [x] Rank the remaining results conservatively and expose provenance for each suggestion
- [x] Never emit a citation suggestion that lacks retrieved backing metadata

## Known Issues (2026-04-12)

- **Inline `/cite` detection does not trigger.** Typing `/cite smith 2020` + Enter inserts the text literally instead of opening the cite modal. The CiteCommandExtension keymap intercepts Enter only when the full line matches `/cite ...`, but in practice the line may contain preceding text or the keymap priority may be too low relative to other Enter handlers. The keyboard shortcut (Cmd+Shift+C) works correctly. Fix deferred — see Story 007.
- **Bibliography file insertion broken.** Clicking "Insert citation" adds `\cite{key}` at the cursor but does not add the BibTeX entry to the project's `.bib` file. The `cite-insert-entry` event reaches `BibliographyContext`, but `handleImportEntry` requires a `targetBibFile` and `currentProvider` to be set, which are not configured by the `/cite` flow. Fix deferred — see Story 007.
- **arXiv and PsyArXiv fail with CORS errors.** Both `export.arxiv.org` and `api.osf.io` reject browser-origin fetch requests. These providers need a lightweight proxy or alternative approach. Fix deferred — see Story 009.
- **Citation insertion is not language-aware.** Always inserts LaTeX `\cite{key}` even in Typst documents, where the correct syntax is `#cite(<key>)`. Fix deferred — see Story 007.

## Notes

- The LLM may assist with query construction or relevance ranking, but not with inventing records
- User hints should raise recall when the user remembers partial details, but they must not short-circuit metadata verification
- Conservative recall is preferable to aggressive hallucination-prone suggestions
