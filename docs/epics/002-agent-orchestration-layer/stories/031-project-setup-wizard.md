# Story 031: Project setup wizard + calmer PM

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** L

## Goal

Replace the token-spending PM **intake interview** (story 012 / 015) with a
deterministic, token-free **project setup wizard**, and recast the PM as
gentle and clarifying-only.

The interview was the wrong tool for the job. It burned model quota to collect
data a form handles fine; it re-asked the project type the PI had *just* chosen
at creation; it ran an onboarding pressure campaign of assignments and
deadlines; and the `ask_user` countdown auto-defaulted the question of any PI
who stepped away mid-conversation. Intake is a form. The PM should be the thing
you talk to *after* the form.

This supersedes the "PM interview seeds projects" design decision from
2026-04-13 and the interview half of story 012.

## Acceptance Criteria

- [x] **Token-free setup wizard** (`webapp/src/wizard.ts`): a multi-step modal
      collecting project type (prefilled from creation — never re-asked),
      title, research question, deliverables, timeline, and seed-material
      uploads. No model calls anywhere in the flow.
- [x] Per-project-type collapsible **"What helps here?" guidance rollups**, so
      the PI can see what good seed material looks like without asking.
- [x] Runs **by default on new projects, once** — the auto-open-once guard is
      persisted `config.setup`, not a per-tab `sessionStorage` flag (so it
      doesn't re-fire in a second tab, and does survive a reload).
- [x] **Abortable and resumable** with answers prefilled; the project browser
      exposes the entry point as "Set up / Resume setup / Edit setup"
      depending on state. Aborts and skips are ignored while a final save is
      in flight (no lost-write race).
- [x] Final step is an explicit **"Start research & skeleton now / Not yet"**
      gate — the pipeline never starts behind the PI's back — with a gentle
      one-time nudge when no seed materials were uploaded.
- [x] **Seeding pipeline drops the PM-interview stage** (`agents/seeding.js`):
      it now runs research → skeleton directly from the wizard-saved config,
      and aborts cleanly on an unconfigured project rather than improvising.
      The seeding panel's interview stage row is gone.
- [x] **`PUT /api/projects/:id/config`** (`routes/projects.js`) — token-free
      draft and final saves; camelCase wizard answers → snake_case canonical
      config + `project.json`.
- [x] Shared **`applyProjectConfig`** helper (`agents/project-config.js`),
      used by both the new endpoint and the retained `save_project_config`
      agent tool — one write path, not two drifting ones.
- [x] **`ask_user` countdown removed**: `config.questionTimeoutMs` defaults to
      `null`, questions wait indefinitely until answered or teardown, and the
      question card loses its countdown/depletion UI. Env override preserved
      for tests.
- [x] **PM prompt rewritten** (`db/prompts/pm.md`): the wizard owns intake; the
      PM reads `project.json` and picks up from there, asks only genuine
      clarifications, nudges once and gently on thin seed material, and issues
      no assignments and no reply deadlines.
- [x] Backend vitest **200/200 green** — new coverage for `project-config`,
      the `PUT config` endpoint, no-timeout `ask_user`, and the
      research→skeleton pipeline including the unconfigured-project guard.
      Webapp `npm run build` (tsc + vite) clean.

## Notes

- Shipped in **PR #32** (merge commit `7721cb2`, 2026-07-14). 23 files,
  ~3,000 insertions.
- Spec: `docs/superpowers/specs/2026-07-13-project-setup-wizard-design.md`
  Plan: `docs/superpowers/plans/2026-07-13-project-setup-wizard.md`
- This story was written *after* the merge to close the gap flagged in the
  PR's own follow-ups — the work shipped without a story record, which the
  epics rules require. The record is reconstructed from the PR, the spec/plan
  docs, and the merged diff.
- Key files: `webapp/src/wizard.ts` (new), `webapp/src/question-card.ts`,
  `webapp/src/main.ts`, `webapp/src/project-browser.ts`, `webapp/src/api.ts`,
  `agent-backend/src/agents/project-config.js` (new),
  `agent-backend/src/agents/seeding.js`, `agent-backend/src/routes/projects.js`,
  `agent-backend/src/config.js`, `agent-backend/src/db/prompts/pm.md`.
- **Deferred to [Story 032](032-wizard-live-verification.md)** — interactive
  browser E2E of the wizard flow. The webapp has no unit-test harness, so the
  data contract was verified statically only.
- **Deferred to [Story 033](033-edit-setup-legacy-config.md)** — "Edit setup"
  on a project configured through the legacy agent tool opens with only the
  type prefilled.
- Remember `npm run db:seed` after touching `db/prompts/pm.md` — prompts are
  served from the DB, not from disk. (Backend startup re-seeds, so a
  `node --watch` restart covers it in dev.)
