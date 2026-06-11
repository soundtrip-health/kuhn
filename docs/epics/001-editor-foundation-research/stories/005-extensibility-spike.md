# Story 005: Extensibility Spike

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** L

## Goal

For the top 1-2 candidates (determined by Stories 001-004), build a minimal proof-of-concept that demonstrates our core extension pattern: a slash command that invokes an agent and inserts the result into the editor.

## Acceptance Criteria

- [x] For each candidate: fork the repo and add a `/hello` slash command that:
  - Triggers on typing `/hello` in the editor
  - Shows a command palette or inline UI
  - Calls a mock backend endpoint
  - Inserts the response text at the cursor position
- [x] Document the difficulty level and code touched for each candidate
- [x] Assess how natural the extension pattern feels — is it fighting the architecture or working with it?
- [x] Note any blockers or fundamental limitations discovered

## Resolution

This spike was completed — and far exceeded — by Epic 003's `/cite` implementation on TeXlyre. Rather than a minimal `/hello` proof-of-concept, we built a production-quality slash command with:

- Inline trigger on typing `/cite` in the editor
- Multi-provider search UI (PubMed, arXiv, IEEE Xplore, OpenAlex, etc.)
- Grounded retrieval with real citation insertion at cursor
- BibTeX bibliography management

**Extensibility assessment:** TeXlyre's architecture worked *with* us, not against us. The service-based structure in `src/services/` and CodeMirror 6 extension model made slash command integration natural. No core internals needed forking — the extension pattern felt first-class.

**BusyIDE spike was not performed.** The decision was made based on the strength of the TeXlyre result. BusyIDE's extensibility remains untested but is no longer decision-relevant.

## Notes

- The original plan called for a `/hello` proxy — `/cite` was a much stronger signal
- Epic 003 stories 002–007 contain the detailed extension point mapping and implementation work
