# Story 003: Deep-Dive: BusyIDE / BusyTeX

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** L

## Goal

Thoroughly evaluate BusyIDE and BusyTeX as a potential editor foundation. Clone the repos, build them, assess code quality, and determine extensibility.

## Acceptance Criteria

- [ ] Successfully build and run BusyIDE locally
- [ ] Document the tech stack and understand the WASM compilation pipeline
- [ ] Map the architecture — how does the editor connect to the WASM TeX engine?
- [ ] Assess code quality: language, test coverage, documentation
- [ ] Identify extension points — where would slash commands and agent integration hook in?
- [ ] Evaluate the WASM TeX engine: which TeX distribution is it based on? What are the limitations?
- [ ] Evaluate Typst support feasibility
- [ ] Assess performance: compilation speed, memory usage, large document handling
- [ ] Confirm MIT license and check all dependencies for license compatibility

## Resolution

**Superseded.** The editor foundation decision was made without completing this deep-dive. After hands-on experience with TeXlyre in Epic 003 (which proved extensibility and product fit), the project adopted TeXlyre with an open-core commercialization strategy. BusyIDE remains a potential reference for WASM compilation techniques if needed in the future, but a full deep-dive is no longer necessary for the decision.

## Notes

- Repo: https://github.com/busytex/busyide (IDE), https://github.com/busytex/busytex (TeX engine)
- MIT license is ideal for our purposes
- WASM compilation is interesting for offline/low-latency use but may have limitations with complex packages
- Key question: is the WASM engine complete enough for real scientific documents?
