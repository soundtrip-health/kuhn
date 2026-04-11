# Story 005: Evaluate Custom Build Approach

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Design what a custom-built orchestration layer would look like — a thin dispatch layer on top of the Anthropic SDK that preserves our CLAUDE.md-driven architecture while adding programmatic control.

## Acceptance Criteria

- [ ] Sketch the architecture: router, agent sessions, tool registry, streaming multiplexer
- [ ] Estimate scope: how many components, roughly how much code?
- [ ] Identify which parts are genuinely custom to our use case vs. generic plumbing
- [ ] List what we'd be giving up by not using a framework (observability, retries, state persistence, etc.)
- [ ] List what we'd gain (full control, no dependency risk, exact-fit abstractions)
- [ ] Assess the CLAUDE.md-as-system-prompt pattern: can this carry forward into the webapp, or do we need structured agent definitions?
- [ ] Draft a rough API design for the dispatch layer

## Notes

- The current architecture already works well — the question is how much of it translates to programmatic use
- A custom build doesn't mean building everything from scratch — it means using the Anthropic SDK directly with our own thin orchestration on top
- The risk is underestimating scope — agent orchestration has many edge cases (retries, timeouts, context overflow, tool failures)
- The reward is zero framework lock-in and a system we understand completely
