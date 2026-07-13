# Story 004: Org library UI & onboarding

**Status:** done
**Epic:** [006 — Org Knowledge Library](../index.md)
**Estimate:** L

## Outcome

All acceptance criteria met (2026-07-13). New `webapp/src/org-library.ts`
plus wiring in `breadcrumb.ts`, `files.ts`, `api.ts`, `icons.ts` (book icon),
`style.css` (`ol-*`/`om-*` on the `pb-*` overlay pattern).

- **Org-creation modal** replaces the `window.prompt` interim: step 1 name +
  live slug preview (mirrors the backend slugify); step 2 "Seed your
  organization's library" with drop-zone/picker upload, per-file live status
  rows, and the no-guilt "Skip for now — you can add documents anytime from
  the org menu". Dialog semantics per 005-004 (focus trap, `aria-modal`,
  Escape, backdrop click).
- **Library panel** (`pb-overlay`-consistent): documents with title,
  filename/size/source (Uploaded / From project / Guidance import), live
  ingestion status (queued/processing spinner → "Searchable" → failed with
  `status_detail` and "delete it and upload a revised copy"), upload zone,
  hover delete. Reached from a persistent **"Org library…"** entry in the
  breadcrumb org menu.
- **Empty state + hint**: inviting empty state in the panel; the org-menu
  entry carries a "Set up" tag until the org's first document is `ready`
  (cached per org, refreshed in place on menu open).
- **Promote from project**: book action on every file row → confirm naming
  the org → `POST /files/promote`; the row shows the file manager's dormant
  `ingesting` spinner then `done` check (Epic 005 badges finally lit), driven
  by a shared org SSE feed with an immediate status check (fast-ingest race)
  and poll-while-open fallback when the feed drops. Promoted docs show
  "From project" provenance in the panel.
- **Live updates**: one shared org-feed manager (`doc_status` over
  `GET /api/orgs/:id/events`) serves the panel, the seed step, and promote
  watchers; listeners own the feed's lifetime.

Verified live (`npm run library-check`, token-free, new script): 21/21 —
create-org 201, promote 201 + dedupe + owning-org, browser promote badge
ingesting→done, modal dialog/slug/Escape-no-create, "Set up" hint appears and
clears, empty state, panel upload → row → "Searchable" via the live feed,
API-confirmed `ready`, self-cleaning. `npm run build` clean;
`files-check` still green (files.ts touched); panel + modal visually
verified via screenshot.

## Goal

Make building the library the natural first act of setting up an org, and
keep it one click away afterwards. Today org creation is a bare
`window.prompt` (`webapp/src/breadcrumb.ts:113-115`) and there is no org-level
surface in the UI at all beyond the switcher.

## Acceptance Criteria

- [x] **Org-creation modal** replaces `window.prompt`: step 1 name (+ derived
      slug preview); step 2 "Seed your organization's library" — drag-and-drop
      /file-picker upload of SOPs, style guides, templates, guidance, with an
      explicit, non-guilt "Skip for now — you can add documents anytime from
      the org menu" path. Dialog semantics per the Epic 005-004 pattern
      (focus trap, `aria-modal`, Escape).
- [x] **Org library panel**: a browsable view (overlay consistent with the
      project browser) listing library documents with title, size, source
      (upload / promoted from project / guidance import), ingestion status
      (`pending`/`ingesting` spinner/`ready`/`failed` with detail), upload and
      delete. Reached from a persistent "Org library" entry in the breadcrumb
      org menu.
- [x] **Empty-state prompt**: an org with zero library documents shows an
      inviting empty state in the panel, and the org menu entry carries a
      subtle "set up" hint until the first document is `ready`.
- [x] **Promote from project**: a per-file action in the file manager
      ("Add to org library") calling Story 001's promote endpoint, with a
      confirmation naming the org; promoted files show source provenance in
      the library panel.
- [x] Ingestion status updates live where Epic 005's feed exists, else
      poll-while-open; the file manager's `ingesting`/`done` badges activate
      for promoted files during their ingestion.
- [x] Errors surfaced honestly: failed ingestion shows `status_detail`
      (e.g. "no extractable text") with a delete/replace affordance — no
      silent `failed` rows.
- [x] `npm run build` clean; a token-free check script covers create-org →
      upload → status → visible-in-library.

## Notes

- Files: `webapp/src/breadcrumb.ts` (menu + modal trigger), new
  `webapp/src/org-library.ts`, `files.ts` (promote action), `api.ts` (library
  client), `style.css`.
- Keep the modal dependency-light and consistent with `kuhn-tokens.css` — no
  component library.
- Invites/roles remain out of scope (Epic 007+); `role` is available on `Org`
  if the panel wants to gate delete to owners, but don't build role UI here.
