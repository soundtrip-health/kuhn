# Osmind tenant guidance (staging)

Organization-specific guidance for **Osmind**, staged here for import into
Osmind's **per-tenant knowledge base** when Kuhn is deployed for them. This is
**not** part of Kuhn's shared, product-level guidance corpus.

> **Why this is separate.** Kuhn's architecture (see
> [`docs/architecture.md`](../../docs/architecture.md) §Knowledge Base Tenancy)
> draws a hard line: the **shared guidance corpus** (`guidance-docs/`) is
> Kuhn-curated, generic, public regulatory/journal/funder guidance available to
> every tenant; a **per-tenant KB** holds a tenant's own uploads and never flows
> into the shared corpus, and is never shared across tenants. The material here
> names Osmind's production data warehouse, its EHR schemas, and a confidential
> client regulatory example — it belongs to the tenant, not the product.
>
> The *practices* in these files (spot-check free-text predicates, QC event
> dates, prefer structured fields, prespecify cohorts) generalize; the *table
> and column names*, and the worked example, do not.

## Provenance

Extracted on ingestion from `AGENT_GUIDANCE.md` — the consolidated guidance from
a predecessor scientific-writing project. Only the Osmind/client-specific
portions were pulled here; the generic guidance went into Kuhn's agent prompts
and shared corpus. Company names in the regulatory worked example are
confidential.

## Contents

| File | What it is | Source |
|------|------------|--------|
| [`rwd-column-catalog.md`](rwd-column-catalog.md) | Osmind's real-world-data warehouse column catalog: schemas, tables, columns, predicate idioms, quirks, event-date QC. | AGENT_GUIDANCE.md Part VIII |
| [`ketamine-esketamine-analysis-conventions.md`](ketamine-esketamine-analysis-conventions.md) | Shared analysis conventions for IV ketamine vs IN esketamine RWD studies in the Osmind warehouse (arms, windows, outcome, effective-dose harmonization). | AGENT_GUIDANCE.md Part VIII (final section) |
| [`rwe-analyst-pipeline.md`](rwe-analyst-pipeline.md) | The Osmind RWE analyst pipeline (nrx-rwe-protocol): PostgreSQL client, cohort temp-table build order, env setup, key commands. | Extracted from `analyst.md` during ingestion |
| [`ptsd-pharmacotherapy-and-instruments.md`](ptsd-pharmacotherapy-and-instruments.md) | PTSD antidepressant prescribing landscape and CAPS-5 vs PCL-5 outcome instruments + bridging. Public literature; magnitudes must be re-sourced before use. | AGENT_GUIDANCE.md Part IX |
| [`fda-rwe-worked-example.md`](fda-rwe-worked-example.md) | The client-specific FDA-RWE worked example — what landed with FDA, the retrospective+prospective-registry design, and the transferable lessons as they applied to Osmind's interventional-psychiatry network. | AGENT_GUIDANCE.md Part VII (client-specific portions) |

## Related

- The **generic** FDA-RWE frameworks and briefing-book genre conventions (the
  non-client parts of Part VII) live in the shared corpus at
  [`guidance-docs/rwe-protocol/fda-rwe-frameworks.md`](../../guidance-docs/rwe-protocol/fda-rwe-frameworks.md).
- The analyst agent prompt (`agent-backend/src/db/prompts/analyst.md`) is now
  tenant-neutral; the Osmind warehouse/pipeline specifics it used to carry were
  extracted into `rwe-analyst-pipeline.md` and `rwd-column-catalog.md` here.
