# Story 004: Evaluate Third-Party Frameworks

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Deep evaluation of the top 2-3 third-party frameworks identified in Story 002. For each, understand the programming model, try to implement our core patterns, and assess the trade-offs.

## Acceptance Criteria

- [ ] For each shortlisted framework:
  - Clone/install and run the getting-started example
  - Attempt to model our Writer + RA citation-lookup flow
  - Assess streaming support (can we stream partial responses to a WebSocket?)
  - Assess MCP server integration (or tool-use equivalent)
  - Evaluate lock-in: how coupled is the code to this framework?
  - Check dependency weight: what does it pull in? Any problematic transitive deps?
  - Review the source code quality and documentation
- [ ] Document strengths and weaknesses of each relative to our requirements
- [ ] Identify any dealbreakers (e.g., no streaming, Python-only when we need TS)

## Notes

- Likely candidates from survey: LangGraph, CrewAI, possibly AutoGen or Mastra
- Be skeptical of demo-quality multi-agent examples — test with our actual interaction patterns
- Pay attention to error handling and observability — when an agent fails mid-flow, how do you debug it?
- Framework lock-in is a real risk — if we adopt a framework and it stalls, how hard is it to migrate?
