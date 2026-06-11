# Story 003: Spike in-browser Qwen 3 1.7B integration

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** L

## Goal

Evaluate whether Qwen 3 1.7B is practical as a browser-resident model for low-latency assistant tasks inside Kuhn.

## Acceptance Criteria

- [ ] Select a candidate browser runtime and packaging approach for the model
- [ ] Measure startup cost, memory footprint, first-token latency, and steady-state latency on representative hardware
- [ ] Determine whether the model is suitable for tasks such as intent classification, nearby-context reading, query generation from context plus user hints, and result summarization
- [ ] Document where the model should not be trusted, especially for bibliographic facts
- [ ] Produce a recommendation: proceed, defer, or swap models

## Notes

- This spike is about feasibility, not full production hardening
- The model's primary `/cite` role is query construction from editor context plus optional user hints
- A negative result is acceptable if it saves time and complexity
