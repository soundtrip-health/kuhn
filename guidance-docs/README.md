# Guidance Docs — the Kuhn knowledge library

The Kuhn-curated, cross-org knowledge catalog (issue #65): selectable
**knowledge packages** of reporting standards, regulatory guidance, and style
references, organized by discipline. The machine-readable manifest,
[`catalog.json`](catalog.json), is the single source of truth the app consumes
— the backend seeds `knowledge_packages`/`knowledge_items` from it at startup
(`agent-backend/src/db/seed.js`), org owners enable packages or individual
items in the org admin **Knowledge** tab, and enabled items are imported into
that org's library where `search_org_knowledge` finds them.

See `docs/specs/065-general-knowledge-library.md` for the full design.

## Layout

```
guidance-docs/
├── catalog.json                    # THE manifest — packages, items, versions
├── catalog/                        # curation inputs: per-domain source lists (not app-consumed)
├── shared/                         # original cross-cutting files, referenced by the manifest
└── <package-id>/                   # package content: knowledge cards + vendored documents
    ├── general-scientific-writing/
    ├── biosciences/  biosciences-regulatory/  biosciences-clinical-trials/  biosciences-drug-development/
    ├── machine-learning/  robotics/  chemistry/  physics/
    └── social-sciences/  statistics-reproducible-methods/  environmental-earth-sciences/
```

## Item kinds — the licensing rule

- **`document`** — the file itself is vendored here. Only for content Kuhn may
  redistribute: US-government public-domain works, CC-licensed standards, or
  Kuhn-authored material (everything under `shared/`).
- **`knowledge-card`** — a Kuhn-authored markdown summary (scope, key
  requirements, how to apply it, canonical link) of a document we may **not**
  redistribute (ICMJE, ISO, ACS, IEEE, ICH…). The card is what gets ingested;
  readers follow the link for the full text. Cards are first-class items —
  agents get real searchable content either way.

## Editing the catalog

1. Author or revise content under the package directory (cards are original
   prose — never paste copyrighted source text).
2. Update `catalog.json`: add the item (stable `"<package>/<slug>"` id), or
   **bump its `version`** when an existing file's content changes — that is
   what surfaces "update available" to orgs holding the old copy.
3. `cd agent-backend && npm run db:seed` (startup reseeds too).

Items are never deleted from the manifest's history: removing one from
`catalog.json` marks its row unavailable, because orgs may still hold imported
copies. Ids are never reused.

The [`catalog/`](catalog/README.md) directory holds the per-domain source
lists (canonical URLs, publishers, license notes) from the 2026-08 research
pass — the raw material from which items graduate into `catalog.json` after
curator verification.

> **Shared corpus, not tenant material.** Everything here is generic, public,
> product-level guidance available to every org. Organization-specific
> material must **not** live here — it belongs in that org's own library via
> upload or promotion. See `docs/architecture.md` §Knowledge Base Tenancy.
