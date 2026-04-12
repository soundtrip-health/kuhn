# Story 007: Integrate `/cite` into the editor and bibliography workflow

**Status:** ready
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** XL

## Goal

Make `/cite` work end-to-end as a reliable editor command: fix inline slash-command triggering, fix bibliography file insertion so citations land in the project's `.bib` file, and ensure the flow works naturally within TeXlyre's existing bibliography and autocomplete behavior.

## Context from Story 006

Story 006 delivered the retrieval pipeline, modal UI, and keyboard shortcut (Cmd+Shift+C). Three issues surfaced during testing:

1. Typing `/cite` inline does not trigger the modal — the CiteCommandExtension keymap is either too low priority or conflicts with other Enter handlers
2. "Insert citation" adds `\cite{key}` at the cursor but does not write the BibTeX entry to the `.bib` file, because the `/cite` flow does not configure `targetBibFile` in BibliographyContext
3. The user has no way to choose or create the target bibliography file from the `/cite` flow
4. Inserted citation text is always LaTeX format (`\cite{key}`) even in Typst documents — should be `#cite(<key>)` for Typst

## Acceptance Criteria

- [ ] Typing `/cite` or `/cite <hints>` followed by Enter in a LaTeX or Typst file triggers the cite modal (inline slash-command detection)
- [ ] The `/cite` flow detects the bibliography file referenced in the current document (e.g., `\bibliography{references}` or `\addbibresource{references.bib}`)
- [ ] If the document references a `.bib` file, inserted citations are written to that file
- [ ] If no `.bib` file is referenced or exists, create `references.bib` in the project root and notify the user
- [ ] After insertion, the citation key is available to TeXlyre's existing bibliography autocomplete
- [ ] The command displays grounded citation suggestions with source attribution and key metadata
- [ ] Inserted citation text is language-aware: `\cite{key}` for LaTeX, `#cite(<key>)` for Typst
- [ ] Errors, loading states, and no-result states are handled without blocking editing
- [ ] The flow works with TeXlyre's existing bibliography/autocomplete behavior or documents the gaps clearly

## Technical Notes

### Inline `/cite` detection

The current `CiteCommandExtension` registers a CodeMirror keymap that intercepts Enter when the entire line matches `/cite...`. Possible fixes:

- Raise the keymap priority so it runs before default Enter handling
- Use a `ViewPlugin` or `inputHandler` instead of a keymap to detect the `/cite` pattern after insertion
- Check that the detection works when `/cite` appears mid-line or after indentation

### Bibliography file resolution

The `/cite` insertion path dispatches a `cite-insert-entry` event that BibliographyContext handles via `handleImportEntry`. That function requires:

- `targetBibFile` — must be set before the call
- `currentProvider` — may not apply for `/cite` (which is not a plugin-based provider)

Options:

- Detect the target `.bib` file by scanning the document for `\bibliography{...}` or `\addbibresource{...}` directives
- If the file exists in the project, set it as the target automatically
- If the file does not exist, create it (with user notification) and set it as the target
- Consider bypassing BibliographyContext and writing directly via `BibliographyImportService.batchImport()` with the resolved file path

### Language-aware citation insertion

The current `handleCiteInsert` in `Editor.tsx` hardcodes `\cite{key}`. The insertion must detect the document type (LaTeX vs Typst) and emit the correct syntax:

- **LaTeX:** `\cite{key}` (also consider `\citep`, `\citet` variants — default to `\cite` for now)
- **Typst:** `#cite(<key>)`

The file type is already available via `detectFileType(fileName)` in the editor. Pass it through the cite event or resolve it at insertion time.

### Autocomplete integration

After inserting a new entry into the `.bib` file, ensure TeXlyre's bibliography cache is refreshed so the new key appears in `\cite{}` autocomplete suggestions.

## Notes

- Initial implementation should handle the common LaTeX case first (`\bibliography{...}` / `\addbibresource{...}`); Typst bibliography resolution can follow
- The insertion path should be compatible with both usability and future automation
