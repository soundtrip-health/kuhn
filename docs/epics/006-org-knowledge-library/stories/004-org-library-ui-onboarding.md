# Story 004: Org library UI & onboarding

**Status:** ready
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Goal

Make building the library the natural first act of setting up an org, and
keep it one click away afterwards. Today org creation is a bare
`window.prompt` (`webapp/src/breadcrumb.ts:113-115`) and there is no org-level
surface in the UI at all beyond the switcher.

## Acceptance Criteria

- [ ] **Org-creation modal** replaces `window.prompt`: step 1 name (+ derived
      slug preview); step 2 "Seed your organization's library" — drag-and-drop
      /file-picker upload of SOPs, style guides, templates, guidance, with an
      explicit, non-guilt "Skip for now — you can add documents anytime from
      the org menu" path. Dialog semantics per the Epic 005-004 pattern
      (focus trap, `aria-modal`, Escape).
- [ ] **Org library panel**: a browsable view (overlay consistent with the
      project browser) listing library documents with title, size, source
      (upload / promoted from project / guidance import), ingestion status
      (`pending`/`ingesting` spinner/`ready`/`failed` with detail), upload and
      delete. Reached from a persistent "Org library" entry in the breadcrumb
      org menu.
- [ ] **Empty-state prompt**: an org with zero library documents shows an
      inviting empty state in the panel, and the org menu entry carries a
      subtle "set up" hint until the first document is `ready`.
- [ ] **Promote from project**: a per-file action in the file manager
      ("Add to org library") calling Story 001's promote endpoint, with a
      confirmation naming the org; promoted files show source provenance in
      the library panel.
- [ ] Ingestion status updates live where Epic 005's feed exists, else
      poll-while-open; the file manager's `ingesting`/`done` badges activate
      for promoted files during their ingestion.
- [ ] Errors surfaced honestly: failed ingestion shows `status_detail`
      (e.g. "no extractable text") with a delete/replace affordance — no
      silent `failed` rows.
- [ ] `npm run build` clean; a token-free check script covers create-org →
      upload → status → visible-in-library.

## Notes

- Files: `webapp/src/breadcrumb.ts` (menu + modal trigger), new
  `webapp/src/org-library.ts`, `files.ts` (promote action), `api.ts` (library
  client), `style.css`.
- Keep the modal dependency-light and consistent with `kuhn-tokens.css` — no
  component library.
- Invites/roles remain out of scope (Epic 007+); `role` is available on `Org`
  if the panel wants to gate delete to owners, but don't build role UI here.
