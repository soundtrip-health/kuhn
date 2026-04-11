# Story 004: License Analysis

**Status:** ready
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** M

## Goal

Produce a clear analysis of the licensing implications for each candidate, specifically for our planned distribution model (SaaS webapp, possibly with a self-hosted option).

## Acceptance Criteria

- [ ] AGPL implications documented: what obligations does it create for our codebase?
- [ ] MIT/Apache 2.0 implications documented for comparison
- [ ] Analyze whether AGPL components can be isolated (e.g., AGPL editor in an iframe, MIT backend)
- [ ] Check all transitive dependencies of top candidates for license conflicts
- [ ] Document any dual-licensing or commercial license options available
- [ ] Produce a clear recommendation on which licenses are acceptable

## Notes

- AGPL's "network use" clause is the key concern — it may require open-sourcing the entire webapp
- Some projects offer commercial licenses that relax AGPL terms
- Consider the "AGPL firewall" pattern — can we architecturally isolate AGPL code?
- This story should be informed by Stories 002 and 003 but can proceed in parallel on the legal/theoretical analysis
