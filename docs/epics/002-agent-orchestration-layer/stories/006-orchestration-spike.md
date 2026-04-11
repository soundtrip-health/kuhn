# Story 006: Orchestration Spike

**Status:** draft
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** XL

## Goal

For the top 2 approaches (from Stories 003-005), build a working proof-of-concept that demonstrates the core flow: user types a slash command in the editor, the backend dispatches to the right agent, the agent uses a tool (MCP or code execution), and the result streams back to the UI.

## Acceptance Criteria

- [ ] For each approach, implement:
  - A `/cite <query>` slash command that dispatches to a Research agent
  - The Research agent calls a mock PubMed MCP server (or the real one if available)
  - Results stream back to a simple WebSocket client
  - A `/review` command that dispatches to the Reviewer agent with document context
- [ ] Measure: time to first token, total latency, code complexity
- [ ] Document the developer experience: how natural is it to add a new agent or command?
- [ ] Identify any fundamental limitations or surprises

## Notes

- This is the most important story in the epic — it turns theory into evidence
- The spike should be throwaway code, but the patterns it validates will shape the real implementation
- Streaming UX is critical — if we can't stream partial agent responses, the editor will feel sluggish
- Depends on Stories 003-005 being substantially complete
- Can run in parallel with Epic 001's extensibility spike (Story 005) if the editor side uses a mock
