# Story 002: Survey Orchestration Frameworks

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Produce a landscape survey of agent orchestration frameworks and libraries, evaluated against our requirements from Story 001.

## Acceptance Criteria

- [ ] At least 8 candidates identified and briefly evaluated
- [ ] Comparison matrix covering: language, license, streaming support, MCP/tool use, multi-agent patterns, maturity, community size
- [ ] Known candidates include: Anthropic SDK, Claude Agent SDK, LangGraph, CrewAI, AutoGen, Mastra, Semantic Kernel, Pydantic AI
- [ ] Also evaluate lightweight options: plain SDK + custom dispatch, or libraries like `instructor`
- [ ] Categorize candidates: full framework vs. SDK vs. library vs. custom
- [ ] Shortlist top 3-4 for deeper evaluation

## Notes

- This space moves fast — check release dates, last commit, and GitHub activity
- Weight practical multi-agent support heavily — many frameworks are single-agent focused with multi-agent bolted on
- Our backend language isn't locked yet — Python and TypeScript are both viable, so evaluate across both ecosystems
- Streaming is non-negotiable for the editor UX
