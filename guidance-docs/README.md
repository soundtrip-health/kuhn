# Guidance Docs — curated reference corpus

A living collection of source guidance and reference documents (regulatory
guidance, methodology, regulatory precedents), **organized by project type**.
This is human-curated source material — a candidate corpus for the Advisor agent's
knowledge base. It is not wired into the app; add and reorganize freely.

## Organization

One folder per project type. Add a document by dropping it in the matching folder
(create the folder if it doesn't exist yet) and adding a row to the catalog below.

```
guidance-docs/
├── shared/             # Cross-cutting statistical / methodological / writing references  (populated)
├── grant-application/
├── manuscript/
└── sop/                # Standard Operating Procedures
```

> **Shared corpus, not tenant material.** Everything here is generic, public,
> product-level guidance available to every tenant. Organization-specific material
> (a tenant's data-warehouse schema, confidential regulatory examples) must **not**
> live here — it belongs in that tenant's per-tenant knowledge base. See
> `docs/architecture.md` §Knowledge Base Tenancy.

---

## `shared/`

References that apply across multiple project types.

| File | Key concepts |
|------|--------------|
| `stats-principles-estimands-sensitivity.pdf` | ICH E9(R1) estimand framework; intercurrent-event strategies; sensitivity-analysis principles. Cross-cutting — relevant to RWE, RCT, and clinical manuscripts |
| `consort_diagram_2014.pdf` | CONSORT participant flow diagram — enrollment, allocation, follow-up, and analysis reporting. Cross-cutting — applies to RCT protocols and clinical manuscripts |
| `scientific-writing-style-guide.md` | Prose craft and claim calibration: calibrate claims to evidence, cut surplusage, active voice, abbreviations at first use, IMRaD, section-based editing, TODO discipline. Applies to every project type |
| `reporting-guidelines.md` | CONSORT / STROBE / PRISMA / ARRIVE / SPIRIT — which guideline for which study type + key sections; journal/venue format specs |
| `estimand-framework-and-tte.md` | ICH E9(R1) estimand five-attribute framework and Target Trial Emulation, written out (companion to `stats-principles-estimands-sensitivity.pdf`) |

---

## Suggested materials for the empty buckets

- **grant-application/** — NIH Grants Policy Statement, SF 424 (R&R) Guide, SBIR/STTR directive, funder RFAs/PAs
- **manuscript/** — target-journal author guidelines, ICMJE Recommendations, reporting guidelines (CONSORT/STROBE/PRISMA/ARRIVE)
- **sop/** — 21 CFR Part 11, GxP, ISO 9001, internal QMS requirements
