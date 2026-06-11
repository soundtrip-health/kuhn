# Story 002: Map editor extension points for slash commands and citation insertion

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Identify where TeXlyre should be extended to support slash-command activation, nearby-context extraction, assistant UI, and bibliography insertion.

## Acceptance Criteria

- [x] Identify the CodeMirror and editor-layer integration points for command detection and UI invocation
- [x] Map the current bibliography import, search, and autocomplete flow that `/cite` must integrate with
- [x] Document the file(s) and abstractions most likely to own assistant state and command execution
- [x] Call out any architectural friction that would make slash-command support expensive or fragile

## Recommended Integration Map

### 1. Slash-command detection belongs in a new CodeMirror extension

Primary integration point:

- `texlyre/src/hooks/editor/useEditorView.ts`

Why:

- `useEditorView.ts:374-509` is the assembly point for file-type-specific CodeMirror extensions, completions, toolbar behavior, and editor-local features
- `useEditorView.ts:427-468` already wires LaTeX/Typst editor behavior in one place
- `useEditorView.ts:524-550` shows the established pattern for editor-originated UI actions: a CodeMirror keymap dispatches a DOM `CustomEvent`, then React handles the UI

Recommended shape:

- Create `texlyre/src/extensions/codemirror/SlashCommandExtension.ts`
- Register it from `useEditorView.ts` alongside the existing LaTeX/Typst extensions
- Give it responsibility for:
  - detecting `/cite` in the active editor
  - reading the current selection or nearby sentence context
  - capturing the raw hint text after `/cite`
  - capturing the replacement range so the command text can be removed later
  - dispatching a typed editor-to-React event
  - applying the final insertion once a citation key is accepted

Boundary:

- The CodeMirror extension should detect and collect editor-local state
- It should not own retrieval, ranking, provider logic, or `.bib` mutation

Recommended event payload:

- `command`: `'cite'`
- `queryText`: raw hint text after `/cite`
- `selection`: `{ from, to }`
- `replacementRange`: `{ from, to }`
- `fileType`: `'latex' | 'typst'`
- `contextText`: selected text or the preceding sentence
- `filePath`, `fileId`, `documentId`: enough identity to resolve target bibliography files and reinsertion safely

### 2. React-side assistant state should live alongside editor UI, not in the provider layer

Primary integration point:

- `texlyre/src/components/editor/Editor.tsx`

Why:

- `Editor.tsx:754-787` already demonstrates the event-bridge pattern for comment workflows
- `Editor.tsx:814-835` reacts to editor file context and emits `bib-file-opened`
- `Editor.tsx` already hosts editor-adjacent UI concerns such as formatting, save triggers, comments, linked-file navigation, and bibliography panel toggles

Recommended shape:

- Add an assistant controller under the editor tree, for example:
  - `texlyre/src/components/editor/AssistantCommandController.tsx`
  - or an editor-local state slice inside `Editor.tsx` first, then extract
- Initial responsibilities:
  - receive `assistant-command-invoked`
  - render the `/cite` review UI
  - orchestrate local-model query generation and retrieval
  - hand a validated citation record to the bibliography layer
  - request final replacement in the originating editor

Event bridge recommendation:

- Reuse the existing custom-event bridge rather than inventing a second integration mechanism
- Candidate events:
  - `assistant-command-invoked`
  - `assistant-command-cancelled`
  - `assistant-citation-selected`
  - `assistant-citation-imported`
  - `assistant-command-replace-text`

### 3. Bibliography file targeting already exists and should be reused

Primary integration point:

- `texlyre/src/contexts/BibliographyContext.tsx`

Relevant existing behavior:

- `BibliographyContext.tsx:261-297` refreshes available `.bib` files and can create a new one
- `BibliographyContext.tsx:335-386` reacts to `bib-file-opened` and tracks the editor-selected bibliography file
- `BibliographyContext.tsx:432-509` already coordinates local entries and provider-fetched external entries
- `BibliographyContext.tsx:788+` owns per-entry import behavior for external results

Implication for `/cite`:

- `/cite` should not create a parallel import pathway
- It should reuse the same target-file selection behavior already used by the bibliography panel
- If the user already has a `.bib` file open, that should become the default import target
- If no target `.bib` exists, the command should pause for target selection rather than silently fail

Recommended next abstraction:

- Add a provider-agnostic import helper in `BibliographyContext` or a small shared service that accepts a validated citation candidate and returns:
  - target file path
  - imported key
  - whether the entry was imported, replaced, or reused

Observed gap:

- Current import entrypoints are shaped around the bibliography panel and active provider state
- `/cite` will need a generic entrypoint that works even when no bibliography panel is open

### 4. Actual `.bib` mutation is already centralized and is the correct handoff point

Primary integration point:

- `texlyre/src/services/BibliographyImportService.ts`

Why:

- `BibliographyImportService.ts:295-340` performs batch import with duplicate handling
- `BibliographyImportService.ts:342-375` performs updates
- `BibliographyImportService.ts:287-293` and `338-339` dispatch file reloads and refresh the file tree
- This is the safest place to keep `.bib` mutation logic and duplicate resolution

Implication for `/cite`:

- The assistant path should normalize a selected citation into TeXlyre-compatible import input
- Then call `batchImport(...)` with:
  - `entryKey`
  - `rawEntry`
  - `remoteId`
- After import succeeds, the editor command can insert the citation token at the original slash-command location

### 5. Existing bibliography autocomplete should pick up imported entries with minimal extra work

Primary integration points:

- `texlyre/src/extensions/codemirror/PathAndBibAutocompleteExtension.ts`
- `texlyre/src/extensions/codemirror/autocomplete/BibliographyCompletionHandler.ts`

Why:

- `PathAndBibAutocompleteExtension.ts:37-72` wires the bibliography completion handler into a shared autocomplete processor
- `PathAndBibAutocompleteExtension.ts:205-208` already exposes `refreshBibliographyCache(...)`
- `BibliographyCompletionHandler.ts:41-78` reads all local `.bib` files and builds the citation cache
- `BibliographyCompletionHandler.ts:286-301` limits citation completions to LaTeX and Typst contexts

Implication for `/cite`:

- If `/cite` imports into a real project `.bib` file through the existing import service, autocomplete should see the new key after cache refresh
- This strongly favors real `.bib` persistence over ephemeral in-memory assistant state

Important constraint:

- `PathAndBibAutocompleteExtension.ts:160-208` uses a singleton `globalProcessor`
- That is acceptable for autocomplete, but slash-command execution should not rely on that singleton for command lifecycle state

## Proposed Control Flow for `/cite`

### Invocation

1. User types `/cite ...` in a LaTeX or Typst editor.
2. `SlashCommandExtension` detects the command and captures:
   - selection or previous sentence
   - raw hint text
   - file type
   - replacement range
   - file/document identity
3. The extension dispatches `assistant-command-invoked`.

### Retrieval and Review

4. An editor-side assistant controller receives the event.
5. The controller derives retrieval queries from local context plus optional user hints.
6. The controller calls the citation provider layer and only keeps grounded results.
7. The controller presents validated candidates plus any warning that user hints were ignored or unverified.

### Import and Insert

8. User selects a validated citation.
9. The controller resolves the target `.bib` file using existing bibliography-context behavior.
10. The controller imports the citation through `BibliographyImportService`.
11. On success, the originating editor replaces `/cite ...` with:
   - LaTeX: `\cite{key}`
   - Typst: project-standard Typst citation syntax
12. Bibliography cache refresh makes the entry available to autocomplete and follow-on citation editing.

## Ownership Recommendations

### CodeMirror extension owns

- command detection
- editor-range capture
- local text extraction
- final text replacement in the editor

### Assistant controller owns

- command lifecycle state
- loading/error states
- local-model invocation
- provider orchestration
- candidate review UX

### Bibliography layer owns

- target bibliography file resolution
- import/update/delete semantics
- duplicate handling
- persistence into `.bib`

### Provider layer owns

- source-specific search
- normalization
- validation
- provenance
- ranking inputs

Current provider boundary:

- `texlyre/src/plugins/PluginInterface.ts:87-98` defines the bibliography plugin contract
- `texlyre/extras/bibliography/openalex/OpenAlexBibliographyPlugin.ts:15-58` is representative of the current provider shape

Implication:

- The existing plugin contract is usable for `/cite`, but it is still panel-search-oriented rather than claim-grounding-oriented

## Architectural Friction and Risks

### 1. Custom-event coupling is pragmatic but loosely typed

TeXlyre already relies heavily on DOM custom events across editor/UI boundaries. That keeps the first implementation simple, but payloads can drift.

Recommendation:

- Keep the event bridge for the first pass
- Add a small typed wrapper for assistant events early

### 2. `useEditorView.ts` is already a large assembly point

Adding command behavior directly into the hook would make it harder to maintain.

Recommendation:

- Keep new logic in a dedicated extension file
- Treat `useEditorView.ts` as a registration point, not the implementation home

### 3. Bibliography import currently assumes provider-produced `rawEntry`

Existing import paths operate on serialized BibTeX content.

Implication:

- The citation provider layer must either produce validated `rawEntry`
- Or Kuhn must add one normalization/serialization step before import

Preferred direction:

- Serialize from one normalized citation shape in one place
- Avoid provider-specific raw BibTeX handling spread across the editor flow

### 4. Citation insertion syntax is file-type dependent

LaTeX and Typst do not share the same insertion syntax.

Recommendation:

- Capture `fileType` at invocation time
- Route final insertion through a dedicated formatter helper rather than mixing syntax logic into retrieval/import code

### 5. There is no first-class slash-command framework today

TeXlyre has command-like affordances for comments, formatting, toolbar actions, and bibliography panels, but no general slash-command dispatcher.

Recommendation:

- Implement `/cite` as a dedicated vertical slice first
- Generalize into a reusable slash-command framework only after the first flow works

### 6. Target `.bib` selection may interrupt the command flow

If the user has no selected bibliography file, `/cite` cannot complete cleanly.

Recommendation:

- Reuse existing bibliography target-file behavior
- Pause the command at file selection instead of inserting an unresolved key

## File-Level Recommendations

Most likely files to touch first:

- `texlyre/src/hooks/editor/useEditorView.ts`
- `texlyre/src/components/editor/Editor.tsx`
- `texlyre/src/contexts/BibliographyContext.tsx`
- `texlyre/src/services/BibliographyImportService.ts`
- `texlyre/src/extensions/codemirror/PathAndBibAutocompleteExtension.ts`

Most likely new files:

- `texlyre/src/extensions/codemirror/SlashCommandExtension.ts`
- `texlyre/src/components/editor/AssistantCommandController.tsx`
- `texlyre/src/types/assistant.ts`
- `texlyre/src/services/citations/`

## Notes

- Existing OpenAlex/Zotero integrations are useful anchors for the retrieval side
- The cleanest first implementation is editor-local slash detection plus React-side orchestration, with bibliography persistence delegated to the existing import service
- This mapping de-risks Stories 005, 006, and 007 without forcing a broader TeXlyre architecture rewrite first
