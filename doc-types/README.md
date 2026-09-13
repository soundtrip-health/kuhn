# Kuhn document-type catalog (issue #106)

The document types a project can be — `manuscript`, `grant`, `rwe-protocol`,
`rct-protocol`, `sop`, … — used to be hard-coded in the schema, the routes, the
agent tools and the webapp. They are now a catalog, seeded into
`catalog_doc_types` at startup (like `slide-themes/` and `typst-templates/`),
and organizations can add their own or shadow a Kuhn one (`org_doc_types`,
managed in Org admin → Document types). An active org type of the same slug
wins; disabling an org type falls back to the Kuhn one — disable is never
delete.

## catalog.json

```json
{
  "catalog_version": 1,
  "types": [
    {
      "slug": "manuscript",
      "title": "Manuscript",
      "description": "One line shown in pickers and by the agents' list_doc_types tool",
      "default_template": "manuscript",
      "wizard_hints": ["Four short bullets: what materials help for this type"],
      "guidance": "Markdown, ~150–400 words: what this document type is, its canonical structure, conventions, what reviewers look for."
    }
  ]
}
```

- `slug` — `^[a-z0-9][a-z0-9-]{1,39}$`, unique; the value stored in
  `projects.project_type` and in interchange manifests.
- `title` — the display label (pills, wizard, breadcrumb).
- `description` — one line; optional.
- `default_template` — a Typst template name from `typst-templates/` that the
  setup wizard preselects for this type, or `null`.
- `wizard_hints` — strings shown in the wizard's "Add your materials" step;
  optional.
- `guidance` — injected into every agent's system prompt as a
  `## Document type: <title>` section when the project has this type, and
  named in the seeding-pipeline briefs. Capped by
  `config.docTypes.maxGuidanceBytes` (16 KB) for org rows.

Entries are listed in the order the UI shows them (`sort_order`). Removing an
entry from the manifest marks its row `available = 0` rather than deleting it —
existing projects keep their type. Point `KUHN_DOC_TYPES` at another directory
to seed from a different manifest.
