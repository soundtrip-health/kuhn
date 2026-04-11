# Story 001: Map Current Agent Patterns

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Document the interaction patterns in the current `agents/` architecture so we know exactly what the orchestration layer must support. This is the requirements baseline — any framework we choose must be able to express these patterns.

## Acceptance Criteria

- [ ] Catalog every agent-to-agent interaction (who calls whom, when, why)
- [ ] Document the dispatch patterns: PM fan-out, Writer→RA citation lookup, Writer→Advisor domain question, PM→Reviewer adversarial review
- [ ] Document the approval gates: where does the PI intervene?
- [ ] Map tool use per agent: which MCP servers, which scripts, which file I/O
- [ ] Document context management: how do agents currently handle long documents (section splitting, etc.)
- [ ] Identify which patterns are essential vs. nice-to-have for the webapp
- [ ] Produce a diagram of the interaction flows

## Notes

- Primary source: `agents/CLAUDE.md` and each agent's individual CLAUDE.md
- The current system is conversation-driven — the webapp will need programmatic equivalents
- Pay special attention to the "contract is markdown" principle — does this carry over or does the webapp need structured data?
