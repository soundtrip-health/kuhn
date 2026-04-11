# Epic 002: Agent Orchestration Layer

**Status:** Draft
**Created:** 2026-04-11

## Goal

Decide how the six AI agents (writer, analyst, advisor, research, review, PM) are orchestrated at runtime within the webapp. This means choosing — or building — the layer that manages agent lifecycle, dispatch, inter-agent communication, tool use, streaming responses, and integration with the editor's slash commands.

## Context

The current agent system (`agents/`) is built directly on Claude Code — each agent is a workspace with a CLAUDE.md, and orchestration happens via human-driven conversation and subagent spawning. Moving to a webapp means we need a programmatic orchestration layer that can:

- Dispatch user requests (slash commands, sidebar chat) to the right agent
- Manage agent sessions and context windows
- Stream partial responses back to the editor UI
- Support tool use (MCP servers, code execution, file I/O)
- Handle inter-agent handoffs (e.g., Writer spawning RA for a citation lookup)
- Maintain the "PI is final authority" principle with approval gates

The landscape of agent frameworks is evolving rapidly. Options range from using Anthropic's own SDKs directly, to full-featured orchestration frameworks, to building a custom layer for maximum control.

## Key Decision Factors

- **Control** — can we implement our specific multi-agent interaction patterns (PM dispatch, Writer→RA spawning, Reviewer adversarial loops)?
- **Streaming** — does it support streaming partial responses to the UI? This is critical for UX.
- **Tool use / MCP** — does it integrate with Model Context Protocol servers (PubMed, bioRxiv, ClinicalTrials.gov)?
- **Context management** — how does it handle long documents and multi-turn agent sessions?
- **Complexity** — how much abstraction does it add? Is the abstraction helpful or does it obscure what's happening?
- **Lock-in** — can we swap the underlying model or provider if needed?
- **Maturity** — is it production-ready or still experimental?
- **License** — compatible with our distribution model?

## Candidates (initial list)

| Candidate | Approach | Notes |
|-----------|----------|-------|
| **Anthropic SDK direct** | Raw API calls with manual orchestration | Maximum control, most code to write |
| **Claude Code SDK / Agent SDK** | Anthropic's agent-building toolkit | Purpose-built for Claude agents, may be closest to current architecture |
| **LangGraph** | Graph-based agent orchestration (LangChain ecosystem) | Mature, flexible state machines, but heavy dependency |
| **CrewAI** | Multi-agent framework with role-based agents | Close conceptual fit (roles map to our agents), Python-native |
| **AutoGen** (Microsoft) | Multi-agent conversation framework | Strong multi-agent patterns, active development |
| **Mastra** | TypeScript-native agent framework | Good if we go with a TS backend |
| **Custom build** | Thin dispatch layer on Anthropic SDK | Maximum control, maintain current CLAUDE.md-driven architecture |

## Acceptance Criteria

- [ ] All viable orchestration approaches evaluated against decision factors
- [ ] Current agent architecture mapped — what patterns must be preserved?
- [ ] Proof-of-concept spike for top 2-3 approaches (Writer + RA citation flow)
- [ ] Streaming and tool-use capabilities validated
- [ ] Architecture recommendation written with trade-offs
- [ ] Decision made and documented

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Map current agent patterns](stories/001-map-current-patterns.md) | ready | M |
| 002 | [Survey orchestration frameworks](stories/002-survey-frameworks.md) | ready | M |
| 003 | [Evaluate Anthropic SDKs](stories/003-evaluate-anthropic-sdks.md) | ready | L |
| 004 | [Evaluate third-party frameworks](stories/004-evaluate-third-party.md) | ready | L |
| 005 | [Evaluate custom build approach](stories/005-evaluate-custom-build.md) | ready | M |
| 006 | [Orchestration spike](stories/006-orchestration-spike.md) | draft | XL |
| 007 | [Recommendation & decision](stories/007-recommendation.md) | draft | M |
