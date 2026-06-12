# Story 022: Live Seeding & Reload-Resume Verification

**Status:** deferred (2026-06-12 — bobd is testing the app hands-on; the scripted live
runs stay parked until he triggers them, since they burn his subscription quota)
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Run the live-SDK verification deferred from stories 020 and 015. Both stories are
fully implemented and unit-tested; what remains is exercising them against the real
Agent SDK + DB. This is split out because live runs burn the Claude subscription
quota (the 2026-06-11 interview run hit the session limit mid-run), so they should
be run deliberately, not as part of a build session.

## Background

- The 2026-06-11 live run (project 2, job 8) already confirmed: ask_user round trip,
  `save_project_config` → `projects.config` + `project.json`, RA + Advisor dispatch.
- Still unverified live: reload-resume mid-interview (story 020) and the full
  seeding pipeline end-to-end (story 015).
- Scripted checks are ready in `webapp/scripts/` (backend on :3002, webapp dev
  server on :5174, Playwright):
  - `node scripts/reload-resume-check.mjs` — starts a PM interview, answers one
    question, reloads mid-interview, verifies the transcript restores and the
    resumed session still knows the earlier answer (~1 short Opus interview)
  - `node scripts/seed-check.mjs` — clicks Seed and drives the full pipeline with
    canned answers (PM interview → RA + Advisor → Writer skeleton; the most
    expensive run — Opus PM + Opus Writer)

## Acceptance Criteria

- [ ] `reload-resume-check.mjs` passes: transcript restored after reload, PM
      session resumes with earlier interview answers intact
- [ ] `seed-check.mjs` completes: all stages report done; `project.json`,
      `draft/references.bib`, `research/literature-summary.md`,
      `guidance/index.md`, `draft/main.md`, and `pm/status.md` exist in the
      project workspace and are sane (real citation keys in the skeleton)
- [ ] Token budget observed: the seeding stages complete within the weighted
      budgets (story 020 accounting); note actual weighted usage per stage
- [ ] Findings folded back: any rough edges become new stories or fixes

## Out of Scope

- New functionality — this story only verifies 020/015 against the live SDK
