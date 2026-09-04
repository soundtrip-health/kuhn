# End-to-end test projects

Reproducible fixtures for **manual (or agent-driven) integration testing at the
highest level**: each directory defines a complete Kuhn project — setup-wizard
answers, seed documents or data, and an ordered set of chat prompts — that a
tester recreates from scratch through the real UI, exercising the whole stack
(wizard → seeding pipeline → per-agent chat → editor → render/export).

These complement the token-free check scripts (`webapp/scripts/*-check.mjs`,
see [TESTING.md](../TESTING.md)): the check scripts verify plumbing without
model calls; these projects verify the *product* with real agent runs.

> **Cost warning:** running a project end-to-end burns real model quota
> (seeding alone dispatches Opus PM/Writer tasks). Run deliberately.

## The projects

| # | Directory | What it exercises |
|---|-----------|-------------------|
| 1 | [`01-kuhn-manuscript/`](01-kuhn-manuscript/) | The core writing loop: wizard intake with seed-doc uploads, seeding pipeline, all six agents, `/cite`, review, slides, PDF render + docx/tex export. A manuscript about Kuhn itself (recreates the long-lived Test-Org1/Proj1 dev project from the ground up). |
| 2 | [`02-nsduh-psychedelics/`](02-nsduh-psychedelics/) | The data-analysis loop: a real Postgres database (NSDUH 2023 public-use file) on the internal sandbox network, the **org secrets store** (write-only credentials), analyst `run_script` with secret injection, SQL + survey-weighted statistics, generated tables + figures, and a results manuscript built on them. Doubles as the **admin's guide** to wiring a real deployment to a private data warehouse with fine-grained DB permissions. |

## Common workflow

1. **Start the stack** — backend (`cd agent-backend && npm run dev`) + webapp
   (`cd webapp && npm run dev`), Docker running with the sandbox images built/pulled
   (project 2 additionally needs `docker build -t kuhn/r-analysis:latest docker/r-analysis`).
   `ANTHROPIC_API_KEY` must be set in `agent-backend/.env`.
2. **Create a fresh org + project** via the project browser at
   http://localhost:5174 (any names work; the per-project README suggests
   canonical ones so testers' runs are comparable).
3. **Follow the project's `README.md`** for setup (seed docs / data prep), then
   drive the session from its **`prompts.md`** — wizard answers first, then the
   ordered chat prompts. Each prompt states what to check before moving on.
4. **Judge the run** against the pass criteria in the project README.

## Cleanup

The local `data/` directory is disposable (see [CLAUDE.md](../CLAUDE.md)):
delete `data/db/kuhn.sqlite` + `data/files/` for a fully fresh start, or just
delete the test org/project in the UI. Nothing in a dev checkout is production
data.
