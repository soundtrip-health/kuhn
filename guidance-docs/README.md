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
├── rwe-protocol/       # FDA Real-World Evidence study protocols  (populated)
├── shared/             # Cross-cutting statistical / methodological / writing references  (populated)
├── rct-protocol/       # FDA Randomized Clinical Trial protocols  (add as needed)
├── grant-application/
├── manuscript/
└── sop/                # Standard Operating Procedures
```

> **Shared corpus, not tenant material.** Everything here is generic, public,
> product-level guidance available to every tenant. Organization-specific material
> (a tenant's data-warehouse schema, confidential regulatory examples) must **not**
> live here — it belongs in that tenant's per-tenant knowledge base. See
> `docs/architecture.md` §Knowledge Base Tenancy, and `tenant-guidance/` for
> staged tenant material.

---

## `rwe-protocol/`

FDA guidance and references for designing Real-World Evidence studies. Three
durable regulatory principles anchor design decisions: **(A)** are the RWD fit for
use, **(B)** can the design provide adequate scientific evidence, **(C)** does
conduct meet FDA regulatory requirements.

| File | Source / citation | Key concepts |
|------|-------------------|--------------|
| `framework.pdf` | FDA, *Framework for FDA's Real-World Evidence Program*, Dec 2018 | Overarching RWD/RWE framework; the three durable regulatory principles |
| `assessing.pdf` | FDA CDER/CBER/OCE, *RWD: Assessing EHRs and Medical Claims Data…*, Jul 2024 | Data source relevance, linking, missingness, variable validation (Pillar A) |
| `considerations.pdf` | FDA CDER/CBER/OCE, *RWE: Considerations Regarding Non-Interventional Studies (Draft)*, Mar 2024 | Minimum expectations for substantial evidence; prespecification (Pillar B) |
| `tte_design_2026.pdf` | Target Trial Emulation design review | Emulating RCTs with observational data; pitfalls and best practices |
| `EQUIV.pdf` | EQUIV study protocol | Non-inferiority of IV ketamine vs intranasal esketamine for TRD; our target trial |
| `tms_example.pdf` + `tms_mdd_rwe.md` | TMS label expansion for MDD (precedent) + summary | FDA 510(k) clearance using prespecified retrospective RWD analysis |
| `ema_example.pdf` | EMA regulatory example | Comparative context for non-FDA regulatory pathways |
| `non-inferior-guidance.pdf` | FDA CDER/CBER, *Non-Inferiority Clinical Trials to Establish Effectiveness*, Nov 2016 | NI margins (M1/M2); HESDE; constancy assumption; CI decision logic |
| `mdd-developing-drugs-guidance.pdf` | FDA CDER, *Major Depressive Disorder: Developing Drugs for Treatment (Draft Rev 1)*, Jun 2018 | TRD definition (≥2 prior antidepressants); accepted endpoints (HAM-D, MADRS); NI limitations |
| `rwe-protocol-eval-review.html` | RWE protocol evaluation tool | Interactive tool for assessing RWE protocol quality and completeness |
| `fda-rwe-frameworks.md` | Synthesized reference (from the guidance above) | The three RWE pillars (fit-for-use / adequate design / regulatory conduct), the core-guidance citation table, and the FDA **briefing-book genre** (voice, structure, presenting RWE as synopsis + SAP + data-overview appendix) |

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

- **rct-protocol/** — ICH E6(R2) GCP, ICH E8(R1), ICH E9; SPIRIT 2013; CONSORT 2010
- **grant-application/** — NIH Grants Policy Statement, SF 424 (R&R) Guide, SBIR/STTR directive, funder RFAs/PAs
- **manuscript/** — target-journal author guidelines, ICMJE Recommendations, reporting guidelines (CONSORT/STROBE/PRISMA/ARRIVE)
- **sop/** — 21 CFR Part 11, GxP, ISO 9001, internal QMS requirements
