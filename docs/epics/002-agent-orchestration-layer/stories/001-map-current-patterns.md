# Story 001: Map Current Agent Patterns

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Document the interaction patterns in the current `agents/` architecture so we know exactly what the orchestration layer must support. This is the requirements baseline — any framework we choose must be able to express these patterns.

## Acceptance Criteria

- [x] Catalog every agent-to-agent interaction (who calls whom, when, why) → §2
- [x] Document the dispatch patterns: PM fan-out, Writer→RA citation lookup, Writer→Advisor domain question, PM→Reviewer adversarial review → §3
- [x] Document the approval gates: where does the PI intervene? → §4
- [x] Map tool use per agent: which MCP servers, which scripts, which file I/O → §5
- [x] Document context management: how do agents currently handle long documents (section splitting, etc.) → §6
- [x] Identify which patterns are essential vs. nice-to-have for the webapp → §7
- [x] Produce a diagram of the interaction flows → §8

**Deliverable:** [`agent-patterns.md`](../agent-patterns.md)

## Notes

- Primary source: `agents/CLAUDE.md` and each agent's individual CLAUDE.md
- The current system is conversation-driven — the webapp will need programmatic equivalents
- Pay special attention to the "contract is markdown" principle — does this carry over or does the webapp need structured data?
