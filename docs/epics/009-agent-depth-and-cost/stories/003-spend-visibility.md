# Story 009-003: Live spend visibility & ceilings

**Status:** draft
**Epic:** [009 — Agent Depth & Cost Control](../index.md)
**Estimate:** M

## Goal

Token spend is live, attributable, and cappable. Today `jobs` records token
counts and a per-task budget exists (`AGENT_TOKEN_BUDGET`, story 029), but
nothing is visible until the hard interrupt fires — a PI watched an Advisor
seeding run burn 678k input tokens with no gauge and no lever.

## Sketch

- **Live meter:** the runtime already tracks per-job token deltas for the
  budget check — emit them on the job's event stream (throttled), render in
  the chat header while a run is active and as a final "this run: N tokens"
  line in the transcript. The status bar's existing `#status-tokens` /
  `#status-budget` elements become real.
- **Rollups:** endpoint aggregating `jobs` token columns per project and per
  org over a window; a simple usage view (this week / this month, by agent).
- **Ceiling:** per-org monthly cap in org settings, enforced server-side at
  job creation — over the cap, new jobs are refused with a clear, PI-readable
  error (existing runs finish under their own task budget). Warn in the UI
  at 80%.
- Budget bar coloring as a run nears the task budget (story 029's grace
  band) so an approaching interrupt is visible before it happens.

## Acceptance Criteria

- [ ] A running job shows a live token meter; the finished run's cost is in
      the transcript and on the job record.
- [ ] Per-project and per-org usage rollups (by agent, by week/month) are
      viewable in the UI.
- [ ] An org over its monthly ceiling cannot start new jobs; the refusal
      names the ceiling and where to change it; at 80% the UI warns.
- [ ] Seeding pipeline runs (the historical offender) are covered — their
      stage events carry spend like any job.
- [ ] `docs/data-pipeline.md` abuse-limits section updated.

## Notes

- Companion: Epic 002 story 036 (stop/redirect a running agent) is the
  control lever; this story is the visibility that tells you when to pull it.
  036's registry fix (non-detachable runs unregistered) is a prerequisite for
  a stop button on seeding runs, not for this story.
- Dollar estimates: token→cost mapping varies by model tier per agent
  (`agents.model`); v1 shows tokens with a per-model cost hint, not invoices.
