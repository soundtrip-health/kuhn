# Spec: General Knowledge Library (issue #65)

**Status:** draft spec + implementation plan
**Issue:** [#65 — general knowledge library](https://github.com/rfdougherty/kuhn/issues/65)
**Antecedents:** `docs/architecture.md` §Knowledge Base Tenancy (the "shared
guidance corpus" paragraph), epic 006's deferred item "cross-org shared
Kuhn-curated corpus served centrally (per-org import first)", and the reserved
`org_documents.source = 'guidance-import'` enum value that story 006-001 left
unimplemented.

## 1. Goal

Expand the Kuhn-curated, cross-org knowledge library and make **every item
selectable**, so an org chooses exactly what knowledge its agents draw on.
Items are bundled into **packages** organized as a tree, e.g.:

- general scientific writing
- biosciences
  - regulatory (FDA/ICH/EMA guidance)
  - clinical trials
  - drug development
- machine learning
- robotics
- chemistry
- physics
- general social sciences
- statistics & reproducible methods *(added beyond the issue list)*
- environmental & earth sciences *(added beyond the issue list)*

An org owner enables packages (or individual items within a package); the
selected items are imported into that org's existing knowledge library
(`org_documents` → ingestion → FTS) and become searchable by agents through the
existing `search_org_knowledge` tool. Nothing about the agent-facing contract
changes.

### Non-goals (v1)

- No shared-index search across orgs (per-org copy import, not a central
  corpus with a selection filter — see §8 Alternatives).
- No tenant-authored packages; the catalog is Kuhn-curated only. Tenant
  material continues to flow through upload and promotion.
- No automatic re-import when Kuhn revises a catalog item (v1 exposes an
  explicit "update available" state instead).

## 2. Current state (what exists)

| Piece | Where | Status |
|---|---|---|
| Curated corpus | `guidance-docs/` (README catalog table + `shared/` files) | Content only; **zero references from app code** |
| Org library | `org_documents` + `org_document_chunks` + `org_chunks_fts` (`agent-backend/src/db/schema.sql`) | Done (epic 006) |
| Import chokepoint | `storeOrgDocument()` in `agent-backend/src/routes/org-library.js` | Done; already accepts `source`, dedupes on `(org_id, sha256)`, queues ingest |
| Ingestion | `agent-backend/src/ingest.js` (md/txt in-process; docx/odt/html/rtf/epub via Pandoc; pdf via poppler — all sandboxed) | Done |
| Agent access | `search_org_knowledge` tool (`agents/runtime.js`), org derived server-side from `projectId` | Done |
| Org settings | `org-settings.js` (`library_seeding`, `promotion_policy`, …), owner-only PATCH | Done |
| Packages / catalog / selection | — | **Nothing exists** |

Key facts that shape the design:

- Dedupe is `(org_id, sha256)`: importing the same doc into N orgs makes N
  byte copies and N FTS chunk sets. Accepted cost in v1 (documents are small;
  orgs are few); revisit if it hurts (§8).
- `guidance-docs/` is only partially public: `shared/` is git-tracked;
  `rwe-protocol/` and `tenant-guidance/` are private (git-excluded). The
  catalog must tolerate packages whose content directory is absent in a
  checkout.
- "Guidance" is an overloaded word in this codebase (repo corpus, the per-
  project `guidance/` workspace tree the advisor maintains, and promotion
  approval). This feature consistently uses **knowledge packages / catalog**
  in code and UI to avoid a fourth meaning.

## 3. Catalog: manifest + content

### 3.1 Manifest — `guidance-docs/catalog.json`

A machine-readable manifest, versioned in git, is the single source of truth
for the package tree and its items. The existing `guidance-docs/README.md`
markdown table is superseded for anything the app consumes.

```jsonc
{
  "catalog_version": 3,              // bump on any published change
  "packages": [
    {
      "id": "biosciences",           // stable slug, never reused
      "title": "Biosciences",
      "parent": null,                // or a package id → tree
      "description": "Core life-sciences reporting and data standards.",
      "items": [
        {
          "id": "biosciences/arrive-2-0",   // package-scoped stable id
          "title": "ARRIVE 2.0 — animal research reporting",
          "path": "biosciences/arrive-2.0.md",   // relative to guidance-docs/
          "version": 1,               // bump when the file's content changes
          "kind": "knowledge-card",   // "document" | "knowledge-card"
          "source_url": "https://arriveguidelines.org/",
          "license": "CC-BY 4.0",
          "tags": ["reporting", "animal-research"]
        }
      ]
    }
  ]
}
```

- **Tree, not flat list**: `parent` gives the one level of nesting the issue
  asks for (`biosciences` → `biosciences-regulatory`, `biosciences-clinical-
  trials`, `biosciences-drug-development`). Depth is unrestricted in the
  schema but UI assumes ≤2.
- **Item ids and versions are the upgrade contract**: an imported org document
  records `(catalog_item_id, catalog_item_version)`; a version bump in the
  manifest surfaces as "update available" per org.
- **Two item kinds, one licensing rule**:
  - `document` — the file itself is vendored under `guidance-docs/`. Only for
    content Kuhn may redistribute: public-domain US-government works (FDA,
    NIST, USGS, Belmont…), CC-licensed standards (ARRIVE, FAIR, CC-BY
    guidance), or Kuhn-authored material.
  - `knowledge-card` — a Kuhn-authored markdown summary (scope, key
    requirements, how to apply it when writing, canonical link) of a document
    we may **not** redistribute (ICMJE recommendations, ISO 8373, ACS style,
    ICH PDFs whose terms are unclear…). The card is what gets ingested; the
    reader follows the link for the full text. Cards are first-class items —
    agents get real searchable content either way.
- A package whose content directory is missing from the checkout (private
  material) is skipped at seed time with a warning, not an error.

### 3.2 Content layout

```
guidance-docs/
  catalog.json                  ← manifest (new)
  README.md                     ← human intro; points at catalog.json
  catalog/                      ← curation inputs (new, this PR)
    README.md                   ← what these are, verification caveat
    general-scientific-writing.md
    biosciences.md
    biosciences-regulatory.md
    biosciences-clinical-trials.md
    biosciences-drug-development.md
    machine-learning.md
    robotics.md
    chemistry.md
    physics.md
    social-sciences.md
    statistics-reproducible-methods.md
    environmental-earth-sciences.md
  general-scientific-writing/   ← package content dirs (built during impl.)
  biosciences/…                 ← knowledge cards + vendored public-domain docs
  shared/                       ← existing files; absorbed into packages
```

`guidance-docs/catalog/*.md` are the **source catalogs** produced by the
domain research pass (2026-08-11): per-domain lists of authoritative documents
with canonical URLs, publisher, format, and access/license notes. They are
curation inputs — the raw material from which knowledge cards and vendored
documents are authored — not app-consumed content, and their URLs/details
require curator verification before an item graduates into `catalog.json`.

The existing `shared/` files map into packages (e.g.
`scientific-writing-style-guide.md` → `general-scientific-writing`;
`reporting-guidelines.md`, `estimand-framework-and-tte.md`, ICH E9(R1) PDF →
`biosciences-clinical-trials`).

## 4. Data model

### 4.1 New tables (`schema.sql`)

```sql
-- Kuhn-curated catalog, seeded from guidance-docs/catalog.json (org-independent)
CREATE TABLE IF NOT EXISTS knowledge_packages (
  id          TEXT PRIMARY KEY,          -- slug from manifest
  parent_id   TEXT REFERENCES knowledge_packages(id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1  -- 0 = content dir absent in this deploy
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id          TEXT PRIMARY KEY,          -- "package/slug" from manifest
  package_id  TEXT NOT NULL REFERENCES knowledge_packages(id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  path        TEXT NOT NULL,             -- relative to guidance-docs/
  version     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('document', 'knowledge-card')),
  source_url  TEXT,
  license     TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  available   INTEGER NOT NULL DEFAULT 1
);

-- Per-org selection, item-granular ("make every item selectable")
CREATE TABLE IF NOT EXISTS org_knowledge_selections (
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  enabled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, item_id)
);
```

### 4.2 `org_documents` changes

```sql
ALTER TABLE org_documents ADD COLUMN catalog_item_id TEXT;      -- NULL for uploads/promotions
ALTER TABLE org_documents ADD COLUMN catalog_item_version INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_docs_org_catalog
  ON org_documents(org_id, catalog_item_id) WHERE catalog_item_id IS NOT NULL;
```

The link back to the catalog gives us: idempotent re-import, "update
available" detection (`catalog_item_version < knowledge_items.version`), and
clean removal on deselect. `source` stays `'guidance-import'` (already in the
CHECK constraint).

Selection state is **derived where possible**: an item is "enabled" iff a row
exists in `org_knowledge_selections`; its import status lives on the
`org_documents` row (`pending/ingesting/ready/failed`), reusing the existing
status machinery and SSE `doc_status` events unchanged.

### 4.3 Seeding

`db/seed.js` gains a `seedKnowledgeCatalog()` step (after agents/tools):
read `guidance-docs/catalog.json`, upsert packages and items idempotently
(same parameterized-upsert pattern as agents/tools), mark rows `available=0`
when the file is missing on disk, and **never delete** catalog rows that
disappear from the manifest (mark unavailable instead — orgs may still hold
imported copies). Runs at startup via `init.js` and on `npm run db:seed`.

Catalog file reads bypass `storage.js` deliberately: the catalog is read-only,
Kuhn-shipped, and lives outside all tenant roots. A small dedicated reader
(`db/knowledge-catalog.js`: `resolveCatalogFile()` that confines paths under
`guidance-docs/`, rejecting `..`) keeps the tenancy invariant intact — do
**not** widen `storage.js`'s `resolveSafe`.

## 5. API

All routes follow the existing guard discipline (`requireOrgRole` /
super-admin), 404-unknown / 403-role / 403-suspended, and **must be added to
`routes/tenancy-matrix.test.js`**.

| Route | Who | What |
|---|---|---|
| `GET /api/knowledge/catalog` | any authenticated user | Package tree + items (id, title, description, kind, license, source_url, version, available). No org state. |
| `GET /api/orgs/:orgId/knowledge` | org member | Catalog merged with this org's state per item: `enabled`, `doc_status`, `imported_version`, `update_available`. |
| `PUT /api/orgs/:orgId/knowledge/selections` | org **owner** | Body `{enable: [itemId…], disable: [itemId…]}`. Package-level toggles are client-side expansion to item ids — the API is item-granular only. Enabling inserts selections and queues imports; disabling deletes selections and the linked `org_documents` rows (chunks/FTS cascade via existing delete path). Returns the merged state. Emits `auth_events` audit rows (`knowledge.enable` / `knowledge.disable`, item ids in detail). |
| `POST /api/orgs/:orgId/knowledge/reimport` | org owner | Body `{items: [itemId…]}`. Re-import failed or outdated items (delete + re-store at current version). |

Import mechanics: for each enabled item, read the file via the catalog reader
and call the existing `storeOrgDocument(orgId, buffer, {filename, title,
source: 'guidance-import', createdBy, ingest: true, catalogItemId,
catalogItemVersion})` (chokepoint gains the two passthrough fields).
Everything downstream — dedupe, ingestion, status SSE, FTS — is already
built. Imports for a batch run sequentially through the existing ingest queue;
the UI watches the same `doc_status` events it already watches for uploads.

Suspended orgs: selections are readable, mutations refused (existing guard).

## 6. UI

1. **Org admin → new "Knowledge" tab** (`webapp/src/org-admin.ts`, tab
   registry next to Members/Settings/Promotions) — the primary surface.
   Package tree with tri-state package checkboxes (all/some/none of its items)
   and expandable per-item rows: title, kind badge (`card` vs `doc`), license,
   canonical-source link, ingest status dot, "update available" pill with
   re-import action. Owner can toggle; members see read-only state.
2. **Org creation modal, seed step** (`org-library.ts` `renderSeedStep`) —
   add a compact package picker (packages only, no per-item detail) above the
   existing upload zone, defaulting to "general scientific writing" checked.
   Fine-grained item selection lives in the admin tab.
3. **Org library list** (`org-library.ts` `render`) — imported items show the
   existing `guidance-import` source label; group them under a "Kuhn knowledge
   library" section header so tenant uploads stay visually primary. Delete on
   a catalog-imported row is disabled ("manage in Knowledge tab") to keep
   selection state and documents consistent.
4. **Super-admin console** (`admin-console.ts`) — read-only catalog listing
   with per-org enablement counts. Nice-to-have; last.

Relationship to `library_seeding` org setting: unchanged — it still gates
whether the *seed step* is offered at org creation. Package selection is
orthogonal and always reachable from the Knowledge tab. No new org-settings
key: selection state lives in `org_knowledge_selections`, not the settings
bag (`validateSettingsPatch` only supports boolean/enum specs, and per-item
state is too large for a settings blob).

## 7. Agent-facing behavior

None of the tool contract changes. `search_org_knowledge` already searches
everything `ready` in the org's library, which now includes imported catalog
items. Two prompt-level touches (then `npm run db:seed`):

- `db/prompts/advisor.md` — mention that the org library may include the
  Kuhn knowledge library (reporting standards, regulatory guidance, style
  guides) and that knowledge cards carry canonical links worth citing.
- `db/prompts/writer.md` / `ra.md` — one-line nudge to consult
  `search_org_knowledge` for discipline reporting standards before drafting
  methods/results sections.

## 8. Alternatives considered

- **Central shared corpus with a selection filter in FTS** (one copy of each
  doc, `searchOrgKnowledge` filters by the org's selections): strictly better
  storage/ingest economics and instant enable/disable, but it forks the query
  path in `db/org-documents.js` (`ftsQuery`), complicates the tool contract,
  and diverges from the promotion pipeline's per-org model. Deferred; the
  `catalog_item_id` link makes a later migration mechanical (dedupe by item
  id, repoint, drop copies). Revisit when orgs × items makes duplication
  visible in `KUHN_DATA_DIR` size or seed-time ingest latency.
- **Selection in `organizations.settings`**: rejected — item-granular state
  is relational (audit fields, joins against catalog versions), and the
  settings validator is deliberately tiny.
- **Auto-import on project type** (wire `wizard.ts` `SEED_GUIDANCE` to
  packages): attractive later — a `project_types` → suggested-packages map in
  the manifest — but v1 keeps selection explicit and org-level.

## 9. Implementation plan

Phased so each lands green with tests; roughly one PR per phase.

**Phase 0 — this PR (spec + source catalogs)**
- `docs/specs/065-general-knowledge-library.md` (this file)
- `guidance-docs/catalog/*.md` — 12 domain source catalogs + README
- No code changes.

**Phase 1 — catalog core (backend)**
- Schema: `knowledge_packages`, `knowledge_items`, `org_knowledge_selections`,
  `org_documents` columns + partial unique index.
- `guidance-docs/catalog.json` seeded with an initial thin catalog: map the
  existing `shared/` files into packages, plus ~2–3 authored knowledge cards
  per top-level package so every package is non-empty and demonstrably
  ingestable. (Full curation of the source catalogs is ongoing editorial
  work, not a code deliverable.)
- `db/knowledge-catalog.js` (reader + path confinement), `seedKnowledgeCatalog()`
  in `seed.js`, wired into `init.js`.
- Tests: manifest validation, idempotent re-seed, unavailable-content
  handling, path-confinement rejection.

**Phase 2 — selection + import API**
- Routes from §5; `storeOrgDocument` passthrough fields; deselect-deletes and
  reimport paths; audit events.
- Tests: enable→import→ready flow (md fixtures, no tokens), idempotent
  re-enable, disable removes doc+chunks+FTS, version-bump → `update_available`,
  suspended-org refusal, **tenancy-matrix rows for every new route**.

**Phase 3 — webapp**
- Knowledge tab in org-admin (tree, tri-state, statuses, reimport).
- Seed-step package picker; library-list grouping; disabled delete on
  imported rows.
- Extend the token-free check scripts (`files-check`-style) with a
  knowledge-selection round-trip.

**Phase 4 — content buildout + polish**
- Author knowledge cards / vendor public-domain docs from the
  `guidance-docs/catalog/` source lists, package by package, verifying URLs
  and licenses as each item graduates into `catalog.json`.
- Super-admin catalog view; advisor/writer prompt touches + re-seed;
  `docs/architecture.md` §Knowledge Base Tenancy updated from "planned" to
  "implemented"; `guidance-docs/README.md` rewritten around the manifest.

**Deployment note** (test server): after Phase 1+ deploys, run
`npm run db:seed` (this joins the already-pending seed TODO for comment
tools), and confirm `guidance-docs/` ships in the deploy artifact — the
backend now reads it at runtime.

## 10. Open questions

1. **ICH/EMA redistribution**: ICH guideline PDFs are freely downloadable but
   their redistribution terms are not obviously permissive — default to
   knowledge-cards until reviewed. FDA/NIST/USGS (US-gov public domain) can be
   vendored freely.
2. **Ingest of vendored PDFs at scale**: enabling a large package queues many
   poppler/Pandoc jobs at once; the existing queue is serial per-process.
   Probably fine; measure in Phase 2 and cap batch size if needed.
3. **Should `biosciences` (parent) auto-enable its option sub-packages?** The
   spec says no — sub-packages are independent toggles; the parent checkbox
   is a UI convenience over its own direct items only.
