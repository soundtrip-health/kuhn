# The Common Technical Document (ICH M4): Organization of Regulatory Submissions

> **Kuhn knowledge card.** Canonical source: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/m4-organization-common-technical-document-registration-pharmaceuticals-human-use-guidance-industry (FDA guidance implementing ICH M4). Source access/license: US government work, public domain; the parallel ICH guideline is freely downloadable from ICH. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

The Common Technical Document (CTD), defined by ICH guideline M4 and adopted by
FDA, EMA, PMDA, and other regulators, is the harmonized organization for
marketing applications for human pharmaceuticals — NDAs, BLAs, ANDAs, and EU
MAAs — and, in practice, the organizing skeleton for INDs and lifecycle
submissions too. M4 specifies *where content goes and at what granularity*, not
what studies to run. Companion guidelines fill the modules: M4Q (Quality), M4S
(Safety/nonclinical), M4E (Efficacy/clinical). Electronic submission of this
structure is the eCTD (ICH M8/M2 heritage), mandatory for most FDA and EU
submissions. Regulatory writers live inside this structure: every summary,
overview, and study report has one defined home.

## Key requirements

**The five modules** — visualized as the "CTD triangle":

- **Module 1 — Regional administrative information.** Not technically part of
  the harmonized CTD; content differs by region (for FDA: forms such as 356h,
  cover letters, proposed labeling/prescribing information, patent
  certifications; for EU: application forms, SmPC).
- **Module 2 — Summaries and overviews.** The CTD table of contents plus
  a brief introduction; the **Quality Overall Summary (QOS, 2.3)**; the
  **Nonclinical Overview (2.4)** and **Clinical Overview (2.5)** — critical,
  interpretive documents; and the **Nonclinical Written and Tabulated
  Summaries (2.6)** and **Clinical Summary (2.7)** — factual, comprehensive
  condensations of Modules 4 and 5.
- **Module 3 — Quality (CMC).** Drug substance (3.2.S: manufacture,
  characterization, control, stability) and drug product (3.2.P: composition,
  development, manufacture, specifications, container closure, stability),
  plus appendices and regional information.
- **Module 4 — Nonclinical study reports.** Pharmacology, pharmacokinetics/
  ADME, and toxicology study reports, ordered by study type and generally by
  species/route within type.
- **Module 5 — Clinical study reports.** Tabular listing of all studies;
  biopharmaceutic, PK, PD, efficacy/safety study reports (organized by study
  type, with ICH E3-format clinical study reports); literature references;
  case report forms and individual patient listings where required.

**Granularity rules.** M4's granularity annex fixes how documents are split:
which headings (e.g., 3.2.S.4.1, 2.7.3) must be single files versus may be
subdivided, section numbering to the fourth level, and pagination/formatting
conventions. In eCTD, each granular document is one leaf file in a defined
folder hierarchy with controlled naming — so how you chunk a document is a
compliance issue, not a style preference.

**Flow of information.** Data lives once, in Modules 3–5; Module 2 summarizes
and interprets it; Module 1 packages regional administration and labeling.
Cross-references point down the triangle (2.5 cites the study reports in
Module 5), never by duplicating content.

## How to apply when writing

- **Start from the target section number.** Before drafting any regulatory
  document, identify its CTD address (e.g., a stability summary is 3.2.S.7.1
  or 3.2.P.8.1; an integrated efficacy discussion belongs in 2.7.3) and follow
  the prescribed heading structure so the document drops into the eCTD without
  restructuring.
- **Match tone to module.** Overviews (2.4, 2.5) argue and interpret — benefit-
  risk, positioning, discussion of discrepancies; written/clinical summaries
  (2.6, 2.7) condense factually without new claims; Modules 3–5 report data.
  Never introduce an argument in a summary that the underlying report cannot
  support.
- **Cite by CTD location**: refer to "Module 5.3.5.1, Study XYZ-301" style
  addresses so reviewers can navigate; keep every cross-reference synchronized
  when documents are renumbered between sequences.
- **Write clinical study reports to ICH E3** so they slot into Module 5 with
  the expected internal structure (synopsis, methods, results, safety
  evaluations, appendices).
- **Respect granularity** when planning authoring and review: one leaf per
  mandated section, consistent numbering to the fourth level, and page
  formatting per the M4 organization guidance.

## Common pitfalls

- Duplicating data across modules instead of summarizing in Module 2 and
  cross-referencing to 3–5 — creates inconsistencies reviewers will find.
- Putting interpretive argument in 2.6/2.7 factual summaries, or leaving the
  2.5 Clinical Overview as a mere abstract instead of a critical benefit-risk
  analysis.
- Treating Module 1 content (labeling, regional forms) as harmonized —
  it must be rebuilt per region.
- Ignoring the granularity annex, producing monolithic files or nonstandard
  splits that fail eCTD validation or force late repackaging.
- Inconsistent numbers between the QOS/summaries and the source reports —
  regulators reconcile them line by line.
- Citing studies without their CTD location, forcing reviewers to hunt through
  Module 5.

## Canonical links

- https://www.fda.gov/regulatory-information/search-fda-guidance-documents/m4-organization-common-technical-document-registration-pharmaceuticals-human-use-guidance-industry — FDA M4 organization guidance
- https://www.ich.org/page/ctd — ICH CTD portal (M4, M4Q, M4S, M4E)
- https://www.fda.gov/drugs/electronic-regulatory-submission-and-review/electronic-common-technical-document-ectd — FDA eCTD portal and specifications
