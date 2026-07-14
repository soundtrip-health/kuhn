# Story 032: Live verification of the setup wizard flow

**Status:** ready
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

Drive the [story 031](031-project-setup-wizard.md) wizard end-to-end in a real
browser against a running stack. The wizard shipped with its data contract
verified **statically only** — the webapp has no unit-test harness, so no test
has ever actually opened the modal, filled it in, and watched a project get
configured. The whole point of the wizard is that a human walks through it;
nothing has yet confirmed a human can.

Sibling of the parked [story 022](022-live-seeding-verification.md) (live
seeding checks). If 022 is picked up at the same time, do them together — they
share a stack and the second half of this flow *is* seeding.

## Acceptance Criteria

- [ ] New project → wizard **auto-opens once**; does not re-open on reload, and
      does not re-open in a second tab (the persisted `config.setup` guard, not
      the retired `sessionStorage` one).
- [ ] Project **type is prefilled** from creation and is never re-asked.
- [ ] Full walk-through — type, title, research question, deliverables,
      timeline, seed upload — **persists**: `project.json` and the `projects`
      row hold the expected snake_case config, and the uploaded file lands in
      project storage.
- [ ] **Abort mid-wizard**, then reopen via the project-browser action:
      answers are **prefilled** from the saved draft, and the action label
      reads correctly across states ("Set up" / "Resume setup" / "Edit setup").
- [ ] The **"Not yet"** gate leaves the project configured but **unseeded** —
      no research/skeleton job starts.
- [ ] The **"Start research & skeleton now"** gate starts the pipeline, the
      seeding panel shows research → skeleton with **no interview stage row**,
      and it completes. (Spends model quota — budget for one run.)
- [ ] The **thin-seed nudge** appears when no materials were uploaded, and only
      once.
- [ ] **PM chat after setup** does not re-ask anything the wizard collected —
      it reads `project.json` and picks up from there.
- [ ] Capture the run (GIF or screenshots) and record the result in this story.

## Notes

- Token-free scripts (`webapp: npm run smoke`, `editor-check`, `parity-check`)
  cover none of this — the wizard is new surface with no script. Consider
  adding a `wizard-check` to that family for the token-free portion (everything
  except the seeding gate).
- Watch the known hazards while testing: a **duplicate backend** process and a
  **stale Yjs room** both produce confusing results; the webapp loads
  `project[0]` by default, so create/select the test project explicitly.
- Backend prompts come from the DB — if `pm.md` was touched, `npm run db:seed`
  (or a backend restart) before judging PM behavior.
