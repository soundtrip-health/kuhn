# Story 003: Evaluate Anthropic SDKs

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Deep evaluation of Anthropic's own offerings for agent orchestration: the base Anthropic SDK (Python and TypeScript), the Claude Agent SDK, and any relevant managed-agent APIs. Since we're building on Claude, staying close to the source has advantages.

## Acceptance Criteria

- [ ] Evaluate the Anthropic Python SDK for: streaming, tool use, multi-turn, MCP integration
- [ ] Evaluate the Anthropic TypeScript SDK for the same
- [ ] Evaluate the Claude Agent SDK / Claude Code SDK: what does it add beyond the base SDK?
- [ ] Check for managed agent endpoints (e.g., `/v1/agents`, `/v1/sessions`) — are these available and suitable?
- [ ] Assess how our multi-agent patterns (PM dispatch, Writer→RA) would be implemented
- [ ] Document what we'd need to build ourselves on top of each option
- [ ] Assess prompt caching / context window management capabilities

## Notes

- The current system already runs on Claude — there's an inherent advantage to staying in the Anthropic ecosystem
- Key question: does the Agent SDK give us enough structure to avoid building our own dispatch, or is it too opinionated?
- Check the latest docs — Anthropic ships frequently and the agent tooling is evolving fast
- MCP is an Anthropic-originated protocol, so their SDKs should have the best MCP support
