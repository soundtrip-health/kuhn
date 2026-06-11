# Story 001: Bootstrap the TeXlyre fork for Kuhn development

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Get the `./texlyre` fork running reliably in the Kuhn repo so we have a stable baseline for editor-side experimentation.

## Acceptance Criteria

- [x] Confirm the required Node/npm toolchain for the current fork and document any mismatches with repo defaults
- [x] Install dependencies and run the local development server successfully
- [x] Document the minimal bootstrap workflow for contributors in Kuhn docs
- [x] Record any fork-specific constraints, missing assets, or upstream issues that affect iteration speed

## Notes

- Treat this as the operational baseline for the rest of the epic
- The TeXlyre fork currently declares a stricter Node requirement than the top-level repo guidance
- Capture practical setup notes, not just theoretical requirements

## Progress Notes

- Added `texlyre/.nvmrc` to pin the fork's declared Node baseline to `24.13.1`
- Added [bootstrap-notes.md](../bootstrap-notes.md) with setup documentation
- Initial attempt with Node v24.2.0 failed (`EBADENGINE`, missing `fs-extra`)
- Installed Node v24.13.1 via nvm — `npm ci`, `npm run dev`, and `npm run build` all succeed
- Dev server verified at `http://127.0.0.1:5173/texlyre/`
