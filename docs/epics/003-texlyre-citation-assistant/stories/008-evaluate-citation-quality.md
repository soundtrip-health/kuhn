# Story 008: Evaluate citation quality and hallucination resistance

**Status:** draft
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Measure whether `/cite` is actually useful and trustworthy enough to continue investing in the pattern.

## Acceptance Criteria

- [ ] Create an evaluation set of representative scientific and technical claims
- [ ] Measure suggestion validity, relevance, and insertion success
- [ ] Record failure modes such as fabricated metadata, weak matches, duplicate results, and empty-result cases
- [ ] Recommend concrete follow-up changes to provider selection, ranking, validation, or UX

## Notes

- This story should be rigorous enough to kill the feature if quality is not there yet
- Evaluation results should inform later `/search` and `/diagram` work
