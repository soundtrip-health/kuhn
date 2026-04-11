# Story 007: Recommendation & Decision

**Status:** draft
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** M

## Goal

Synthesize findings from all prior stories into a recommendation. Present trade-offs clearly for a final decision on the orchestration approach.

## Acceptance Criteria

- [ ] Recommendation document covering:
  - Summary of each approach's strengths and weaknesses
  - Results from the orchestration spike (latency, complexity, DX)
  - Risk assessment: lock-in, maintenance burden, community health
  - Estimated effort to reach production-ready for each approach
  - Clear recommendation with reasoning
- [ ] Decision made and recorded
- [ ] `docs/architecture.md` updated to reflect the chosen orchestration approach
- [ ] Follow-on epic(s) drafted for implementing the chosen approach

## Notes

- This decision interacts with Epic 001 (editor choice) — the backend language may be influenced by both
- The recommendation should consider the team's current strengths (Python for agents, uncertain on TS)
- "Custom build" is a valid answer if the frameworks add more complexity than they remove
- Depends on all prior stories, especially the spike (Story 006)
