# Story 005: Extensibility Spike

**Status:** draft
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** L

## Goal

For the top 1-2 candidates (determined by Stories 001-004), build a minimal proof-of-concept that demonstrates our core extension pattern: a slash command that invokes an agent and inserts the result into the editor.

## Acceptance Criteria

- [ ] For each candidate: fork the repo and add a `/hello` slash command that:
  - Triggers on typing `/hello` in the editor
  - Shows a command palette or inline UI
  - Calls a mock backend endpoint
  - Inserts the response text at the cursor position
- [ ] Document the difficulty level and code touched for each candidate
- [ ] Assess how natural the extension pattern feels — is it fighting the architecture or working with it?
- [ ] Note any blockers or fundamental limitations discovered

## Notes

- This is a spike — code quality doesn't matter, learning does
- The `/hello` command is a proxy for `/cite`, `/research`, `/figure` etc.
- If a candidate makes this trivially easy, that's a strong signal
- If a candidate makes this require forking core internals, that's a red flag
- Depends on Stories 002 and 003 being substantially complete
