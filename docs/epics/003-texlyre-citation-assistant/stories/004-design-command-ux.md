# Story 004: Design the research assistant command UX

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Define how editor-triggered assistant commands should behave, starting with `/cite` and leaving a clean path for `/diagram` and `/search`.

## Acceptance Criteria

- [ ] Define the activation model for slash commands while editing
- [ ] Specify how the command reads the previous sentence or selected text as context
- [ ] Specify how optional user hints are entered, parsed, displayed back to the user, and incorporated into search
- [ ] Specify the result UI for `/cite`, including confidence cues, source attribution, and insertion actions
- [ ] Define failure states and empty-result behavior without encouraging hallucinated output
- [ ] Outline how `/diagram` and `/search` fit the same UX pattern later

## `/cite` Command Contract

### Supported Invocations

- `/cite`
- `/cite <free-text hints>`

### Examples

- `/cite`
- `/cite smith 2019`
- `/cite I think smith 2019 and jones 2021 might be relevant`
- `/cite probably the original transformer paper`

### Command Semantics

- `/cite` with no extra text means: use editor context only
- `/cite <free-text hints>` means: use editor context plus user-supplied retrieval hints
- Hints are never treated as accepted bibliographic facts
- The system may extract structured clues from hints, such as author-like names, years, venue-like phrases, IDs, and topic keywords
- The original free-text hint string should also be preserved because rigid parsing will miss useful cases

## Context Rules

### Default Context

- If the user has a text selection, use the selection as the primary citation target
- Otherwise, use the sentence immediately preceding the slash command
- If that sentence is shorter than a minimum usefulness threshold, expand to the previous two sentences
- Do not automatically read beyond the local paragraph in the first version

### Context Preview

- Before showing results, show the user the exact text span being used as the citation target
- The user should be able to confirm or edit the target text before retrieval is rerun

### Context Privacy

- Local context is sent only to the local browser model by default
- External providers receive generated search queries, not the raw sentence, unless a future provider explicitly requires richer context and the user opts in

## Hint Handling

### Parsing Behavior

- Treat everything after `/cite` as a hint string
- Attempt lightweight extraction of:
  - author-like tokens such as `smith`
  - years such as `2019`
  - title fragments such as `attention is all you need`
  - identifiers such as DOI-like or arXiv-like strings
  - domain keywords such as `graph neural networks`
- Store both:
  - the raw hint string
  - the extracted structured hints

### UX Rules

- Show parsed hints back to the user before or alongside results
- Parsed hints must be visibly labeled as `search hints`, not `verified metadata`
- The user should be able to remove individual parsed hints and rerun search

### Verification Rule

- If a hint appears to name a paper or author-year pair, that still does not count as a valid citation candidate until a provider returns matching metadata

## Retrieval Pipeline UX

### Stage 1: Query Construction

- The local model reads the citation target plus optional hints
- It generates a small set of provider-friendly search queries
- Queries should be biased toward precision over recall

### Stage 2: Provider Search

- Run searches against enabled providers
- Prefer provider-specific fields when hints contain structured data such as author names, year, DOI, PMID, or arXiv ID
- Preserve provenance for every result

### Stage 3: Validation and Ranking

- Normalize provider metadata into a common record shape
- Reject records with insufficient metadata for safe suggestion
- Rank candidates conservatively based on relevance to the citation target plus hint agreement

## Result UI

### Result Card Contents

- title
- authors
- year
- venue or source
- persistent identifier when available, such as DOI, PMID, or arXiv ID
- provider provenance
- short explanation of why the result was surfaced

### Allowed Actions

- `Insert citation`
- `View details`
- `Copy BibTeX`
- `Refine search`

### Confidence Cues

- Do not show vague model-confidence percentages
- Use evidence-based labels such as:
  - `Strong match`
  - `Possible match`
  - `Hint match, low context support`
- Every label must be traceable to retrieval evidence, not model self-assessment

## Failure and Empty States

### No Results

- Tell the user no validated citations were found
- Offer to refine hints or expand providers
- Do not fabricate fallback suggestions

### Weak Results

- Show weak matches in a clearly downgraded section
- Require an explicit user action before insertion if the match quality is low

### Unverifiable Hinted Papers

- If the user hinted something like `smith 2019` and no provider can verify it, show:
  - that the hint was used in search
  - that no matching validated record was found
  - options to edit the hint or broaden the search
- Do not convert the hint itself into a result row

### Provider Failure

- Distinguish provider errors from genuine no-result cases
- Show which providers failed and which completed successfully

## Insertion Behavior

- Inserting a result should:
  - add or update the corresponding bibliography entry in the project
  - insert the citation key at the cursor or replace the original slash command
- The inserted citation must be derived from validated metadata only
- If bibliography insertion cannot be completed, the user may still copy structured citation data manually, but the editor must say why

## Follow-on Commands

- `/diagram` should reuse the same shell:
  - local context capture
  - optional hints
  - result panel
  - explicit insertion or apply action
- `/search` should reuse the same shell but return source-linked research results rather than bibliography entries

## Notes

- `/cite` should default to conservative behavior: fewer, better-backed suggestions
- A command such as `/cite I think smith 2019 and jones 2021 might be relevant` should treat `smith 2019` and `jones 2021` as search hints, not as accepted references
- The UI should make it obvious which source each suggestion came from
- This story is intended to be the product contract for Story 006 and Story 007, not just a brainstorming note
