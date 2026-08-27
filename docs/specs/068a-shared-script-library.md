# Spec: Shared script library (issue #68, part a)

**Status:** implemented (this spec ships with the implementation)
**Issue:** [#68 — shared scripts](https://github.com/rfdougherty/kuhn/issues/68)
**Antecedents:** the deterministic references path (canonical `bib_references`
+ derived bib + tool-enforced writes), the knowledge catalog (issue #65 —
seed/version/select/reimport), and promotion requests (story 011-004 —
copy-on-approve with an atomic decision claim).

Issue #68 lands in two slices. This one builds the **library**: seeded,
versioned, reviewable shared scripts. Part b (`068b`) adds execution — the
sandboxed `run_script` tool and the R image — and is where agents first
touch any of this.

## 1. Goal

Kuhn's "deterministic path" needs shared tooling that outlives a single
project: seed known-good scripts centrally, let orgs adopt them, promote
scripts written during project work (e.g. an analyst's R GAMM script) into
the org library with owner review, and update shared scripts without losing
history.

### Non-goals (v1 / this slice)

- No execution (068b), and no agent-facing tool yet — agents can't use these
  scripts until part b.
- No per-hunk review editing (pending_edits is `draft/`-scoped by design);
  review v1 is read/diff + approve/reject.
- No script deletion — `status = 'disabled'` preserves provenance for the
  `script_runs` records part b introduces.
- No Python execution commitment yet: `.py` files can be promoted and stored
  (the library is language-tagged), but part b's runner starts R-only.

## 2. Design

### Catalog (Kuhn-shipped)

`shared-scripts/catalog.json` + script files, mirroring `guidance-docs/`:
validated by `db/script-catalog.js` (own path confinement — deliberately not
`storage.js`), seeded by `seedScriptCatalog()` in `db/seed.js` with the #65
discipline: idempotent upserts, rows never deleted (dropped/missing →
`available = 0`). Catalog entries carry the run contract: language,
entrypoint, args, inputs/outputs prose, integer version. First entry:
`r/summarize-csv`, a deterministic CSV EDA report.

### Org library

`org_scripts` (slug per org, language, source `catalog-import` |
`project-promotion`, status, catalog link) + `org_script_versions`
(append-only: content TEXT, sha256, entrypoint, change note, source
project/path). Code lives in the DB, not storage.js: scripts are small
(256 KB cap, `config.scripts.maxScriptBytes`), need diffing, and version +
metadata must commit atomically. Current version = `MAX(version)`.
`update_available` = imported catalog version < catalog's current.

### Promotion & review

`script_promotion_requests` parallels `promotion_requests` rather than
reusing it (that table's approve path is org-library-document-specific).
Same invariants: metadata only, copy-on-approve, atomic decision claim
(`UPDATE … WHERE status='pending' RETURNING`), revert-on-failure.

Review is concrete and race-safe: the owner queue serves the **live** file
content plus its sha256 (and the target script's current content, for
new-version proposals — the UI renders a line diff); approve echoes
`expected_sha256` and a mismatch reverts the claim with 409 ("changed since
reviewed"). New scripts take an owner-chosen slug (409 on conflict);
proposals with `target_script_id` append a version to that script.

Entry point `POST /api/projects/:id/files/promote-script` branches on the
existing `promotion_policy` org setting exactly like document promotion:
owners and `direct`-policy orgs copy immediately; otherwise a pending
request is filed (202) and owners see it in the org-admin Scripts tab.

### API summary

- `GET /api/scripts/catalog` — any authed user.
- `GET /api/orgs/:orgId/scripts` (viewer) — catalog merged with org state +
  the org's scripts; `GET …/scripts/:idOrSlug` (viewer) — content + version
  history; `GET …/scripts/:idOrSlug/versions/:v`.
- `POST …/scripts/import`, `POST …/scripts/reimport`, `PATCH …/scripts/:id`
  (status) — owner, audited (`script.import/.reimport/.enable/.disable`).
- `GET …/script-promotions[?status]`, `GET …/script-promotions/:id`,
  `POST …/:id/approve`, `POST …/:id/reject` — owner, audited
  (`script.promotion.approved/.rejected`).

Viewer-visible code is deliberate: org members may read the scripts their
org's agents will run (same stance as agent prompts, issue #67).

### UI

Org-admin overlay gains a member-visible **Scripts** tab: pending
promotions (owner: review code / diff, slug input, approve/reject), the org
library (view code + history, enable/disable, update-from-catalog badge),
and the importable Kuhn catalog. The file manager offers "Promote to org
scripts (S)" on `.R`/`.py` rows next to "Add to org library (L)".

## 3. Files

- `shared-scripts/catalog.json`, `shared-scripts/r/summarize_csv.R`
- `agent-backend/src/db/script-catalog.js`, `db/org-scripts.js`,
  `db/script-promotions.js` (+ colocated tests), `db/seed.js`
  (`seedScriptCatalog`), `db/schema.sql` (four tables)
- `agent-backend/src/routes/scripts.js` (+ test), `routes/projects.js`
  (promote-script), `config.js` (`config.scripts`), tenancy-matrix rows
- `webapp/src/api.ts`, `org-admin.ts` (Scripts tab + line diff),
  `files.ts`, `icons.ts`, `style.css`

## 4. Deferred to part b (068b)

Execution: `run_script`/`list_scripts` agent tools, sandbox R image
(prebuilt, `--network none` intact), script-run provenance, analyst prompt
updates, and the flagship GAMM catalog script (it ships when it can run).
