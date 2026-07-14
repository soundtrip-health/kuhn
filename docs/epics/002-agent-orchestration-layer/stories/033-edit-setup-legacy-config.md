# Story 033: "Edit setup" loses answers on legacy-configured projects

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

A project configured through the **legacy `save_project_config` agent tool**
(i.e. by the old PM interview, before [story 031](031-project-setup-wizard.md))
has `config.title`, `config.research_question` and friends, but **no
`config.setup`** — the wizard's own answers blob. "Edit setup" on such a
project therefore opens the wizard with **only the project type prefilled**;
every other answer looks blank, and saving over it risks clobbering good config
with empty fields.

An exceptional path now — only pre-wizard projects are affected — but it's a
silent data-loss shape, and every project that existed before 2026-07-14 is in
it.

## Acceptance Criteria

- [ ] Opening the wizard on a project with canonical config but no
      `config.setup` **prefills from the canonical config** — reconstruct the
      wizard answers (snake_case → camelCase) rather than starting empty.
- [ ] A save from that reconstructed state **does not blank** any canonical
      field the wizard didn't collect.
- [ ] Covered by a backend test on the reconstruction mapping, and exercised in
      the [story 032](032-wizard-live-verification.md) browser pass against a
      pre-wizard project.

## Notes

- Flagged as a non-blocking follow-up in PR #32.
- Likely home for the mapping: `agent-backend/src/agents/project-config.js`
  (which already owns the camelCase↔snake_case translation in the write
  direction — this is the read direction of the same contract).
- Cheap alternative if reconstruction proves fiddly: a one-shot backfill that
  synthesizes `config.setup` from canonical config for existing rows. Prefer
  the reconstruction — it also covers any future writer that skips the wizard.
