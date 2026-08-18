# TOP Guidelines (Transparency and Openness Promotion)

> **Kuhn knowledge card.** Canonical source: https://www.cos.io/initiatives/top-guidelines (Center for Open Science). Source access/license: freely accessible; guidelines and preprint distributed under CC BY 4.0, so generous summarization is permitted. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

The TOP Guidelines (Nosek et al., first published in *Science* 2015; maintained and updated by the Center for Open Science, most recently in 2025) are a **policy framework for journals, funders, and institutions** rather than an author checklist. They define modular transparency standards that a journal adopts at a chosen stringency level; authors then encounter them as submission requirements — data availability statements, citation rules, preregistration disclosure, and replication policies.

TOP applies across disciplines and study types, quantitative or qualitative, wherever there are data, materials, code, or analysis decisions to disclose. Over a thousand journals and organizations are signatories, and the companion **TOP Factor** metric scores journal policies standard-by-standard.

For authors, the practical upshot is a small set of manuscript artifacts: availability statements for data, code, and materials; formal citations for datasets and software; a preregistration disclosure; and, at stricter venues, a reproducibility package that survives verification.

## Key requirements

**The eight standards**, paraphrased:

1. **Citation standards** — data, code, and research materials are treated as citable scholarly products: cited in the reference list with persistent identifiers, not buried in footnotes.
2. **Data transparency** — disclosure of whether and where the underlying data are available; stronger levels require deposit in a trusted repository.
3. **Analytic methods (code) transparency** — the same, for analysis scripts and computational workflows.
4. **Research materials transparency** — the same, for stimuli, instruments, survey items, and other materials needed to rerun the study.
5. **Design and analysis reporting** — the journal states (or enforces) discipline-appropriate reporting standards and checklists for study design and analysis.
6. **Preregistration of studies** — disclosure of whether the study itself was registered before data collection, with a link.
7. **Preregistration of analysis plans** — disclosure of whether the analysis plan was specified in advance, distinguishing confirmatory from exploratory results.
8. **Replication** — the journal's stance on publishing replication studies, up to accepting Registered Reports with results-blind review.

**The three levels** (per standard, plus a baseline "Level 0" of no policy):

- **Level 1 — Disclose.** Authors must *state* whether data/code/materials are available and whether the study was preregistered, and where.
- **Level 2 — Require.** Availability is mandatory: deposit in a trusted repository (or a stated, justified exception, e.g., legal or ethical restrictions).
- **Level 3 — Verify.** The journal (or a third party) checks the claims — data and code are retrieved and results independently reproduced before publication.

**How journals apply them.** A journal picks a level per standard, so policies are mix-and-match: e.g., Level 2 for data, Level 1 for preregistration. Adoption shows up as required availability statements, submission checklist items, open-practice badges, and Registered Report tracks. The 2025 update reorganizes the standards into a rubric better aligned with the TOP Factor and modern practice (badges, Registered Reports, verification workflows), but the disclose/require/verify logic is unchanged.

## How to apply when writing

- **Check the target journal's TOP level first** (its author guidelines or its TOP Factor entry) — it determines whether statements, deposits, or verification artifacts are needed.
- **Write explicit availability statements** for data, code, and materials — one each, usually in a back-matter "Data availability" section: repository name, persistent identifier/DOI, access conditions. "Available on request" fails Level 2 and is increasingly rejected even at Level 1.
- **Cite data and software formally**: reference-list entries with creator, year, title, repository, version, and DOI — both for datasets you produced and those you reused.
- **Report preregistration status honestly**: give the registry link and registration date; flag every deviation from the registered plan and label non-preregistered analyses as exploratory. If the study was not preregistered, say so plainly.
- **When data cannot be open** (confidentiality, consent limits, third-party ownership), state the specific restriction, what *is* shared (de-identified subsets, synthetic data, metadata, code), and the controlled-access route.
- **Prepare for verification** (Level 3 venues): a runnable analysis package — versioned code, environment/dependencies, seed values, and a README mapping scripts to tables and figures.

## Common pitfalls

- Boilerplate "data available upon reasonable request" statements, which do not satisfy Require-level policies and are rarely honored in practice.
- Depositing data on a lab website or in supplementary files instead of a trusted repository with a persistent identifier.
- Citing a dataset only in the availability statement, not in the reference list (fails the citation standard).
- Claiming preregistration while silently deviating from the registered outcomes or analysis plan.
- Sharing data but not the code (or vice versa), leaving results non-reproducible.
- Conflating FAIR/open data with a requirement that all data be public — TOP explicitly accommodates justified restricted access.
- Writing availability statements at submission time for artifacts that were never actually deposited, forcing a scramble (or a broken link) at proof stage.
- Assuming one journal's TOP level applies everywhere — levels vary by journal and by standard, so requirements must be checked per venue.

## Canonical links

- TOP Guidelines home: https://www.cos.io/initiatives/top-guidelines
- TOP Factor (journal policy scores): https://topfactor.org/
- OSF preregistration initiative and templates: https://www.cos.io/initiatives/prereg
- Registered Reports: https://www.cos.io/initiatives/registered-reports
- TOP 2015 statement in Science (Nosek et al.): https://www.science.org/doi/10.1126/science.aab2374
