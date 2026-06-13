# BrainsWay Deep TMS Adolescent MDD 510(k): Decision Summary and Protocol Impact

## Why this matters for our work

This FDA decision is a recent, concrete example of Real-World Data (RWD) supporting a label expansion in psychiatry. It is not a drug-efficacy approval pathway, but it is highly relevant to our Real-World Evidence (RWE) protocol because it shows how FDA accepted a pre-specified retrospective analysis to support a new indicated population.

For our ketamine vs esketamine target trial emulation (TTE), this case strengthens the argument that a clearly specified question, fit-for-purpose data, and transparent analytic rules can support regulatory decision-making.

## FDA decision at a glance (K251391)

- **Decision type:** 510(k) substantial equivalence clearance (Class II device; 21 CFR 882.5805, product code OBP)
- **Device:** BrainsWay Deep TMS System (Models 102/104)
- **Date of FDA letter:** November 7, 2025
- **Regulatory action:** Cleared for marketing with expanded indication
- **New indication element:** Adjunct treatment of MDD in adolescents aged 15-21 years
- **Adult indication retained:** Treatment of depressive episodes and decreasing comorbid anxiety symptoms in adults with MDD not adequately improved by antidepressants in the current episode

## Evidence package used for the adolescent expansion

From the 510(k) summary and indications documentation in `src/tms_example.pdf`:

- **Data source:** Commercial real-world clinical data from BrainsWay users (registry/database context)
- **Protocolized approach:** Data accrued under a pre-defined clinical study protocol (`RWD-MDDAdol-01`)
- **Population analyzed:** 1,120 adolescents (age 15-21) treated between 2012-2024 at 35 U.S. TMS centers
- **Additional non-ITT records:** 319 adolescents excluded as screen failures per eligibility rules (comparability described)
- **Treatment modalities:** Standard-of-care high-frequency 18 Hz and iTBS protocols
- **Primary depression instrument:** PHQ-9
- **Eligibility structure:** Explicit inclusion/exclusion criteria, including diagnosis definitions, baseline severity thresholds, minimum treatment exposure, and treatment-gap limits
- **Hypothesis framing:** Pre-specified responder-threshold hypothesis based on proportion with PHQ-9 improvement
- **Key efficacy outputs reported:**
  - Mean PHQ-9 change after 36 sessions: approximately -12.1 points
  - Response rate (>=50% PHQ-9 reduction): 66.1% after 36 sessions
  - Remission rate (PHQ-9 < 5): 30.0% after 36 sessions
  - Statistical significance and confidence intervals reported for co-primary analyses
- **Regulatory conclusion in filing:** No new safety/effectiveness questions for the additional adolescent population

## What this signals about FDA expectations for RWD/RWE

Even in a 510(k) substantial-equivalence framework, the submission reflects familiar RWE quality expectations:

- **Pre-specification:** A written protocol, predefined eligibility criteria, predefined analysis sets/endpoints
- **Traceable conduct:** Clear accounting of included vs excluded patients and reasons
- **Clinically interpretable outcomes:** Standardized, accepted scales (PHQ-9; also anxiety signal via GAD-7 in public statements)
- **Pragmatic but disciplined analytics:** Real-world retrospective data with explicit success criteria and inferential statistics
- **Contextualized safety:** Safety interpreted against known prior use and predicate context

## Relevance to our ketamine RWE protocol (TTE)

### 1) Pillar A: Is the RWD fit for use?

This case supports emphasizing:

- Site-level representativeness and data provenance across multi-center routine care
- Structured eligibility logic that can be operationalized reproducibly in EHR data
- Reliable baseline and follow-up outcome capture windows
- Transparent handling of ineligible/insufficient-data records and attrition

**Implication for our protocol:** We should make data quality checks and cohort-flow accounting explicit enough that an external reviewer can reproduce our analysis population definitions from raw EHR extracts.

### 2) Pillar B: Is the study design adequate for the regulatory question?

This case supports:

- Starting from a specific, decision-linked question
- Pre-defining analysis endpoints and success criteria
- Aligning clinical interpretation with real-world care pathways (not trial-only artifacts)

**Implication for our protocol:** Our TTE section should keep tight alignment between the estimand, target-trial components (eligibility, assignment, follow-up, outcome), and the specific non-inferiority decision context.

### 3) Pillar C: Does study conduct meet regulatory requirements?

The FDA materials reiterate broader compliance obligations (e.g., labeling controls, MDR/postmarket reporting, QS obligations), and the submission itself demonstrates disciplined protocol-governed conduct.

**Implication for our protocol:** We should explicitly document governance, version control, change control, and analysis reproducibility steps so reviewers can assess procedural rigor, not only statistical results.

## Limits of analogy to our project

This is a **device 510(k)** substantial-equivalence case, not a drug substantial-evidence determination. We should use it as a methodological and evidentiary precedent for RWD execution quality, not as a direct precedent for evidentiary thresholds in a ketamine drug-effectiveness claim.

## Practical updates to include in our protocol package

1. Add a short case-example paragraph citing this FDA action as evidence that protocolized retrospective RWD can support indication expansion in psychiatry.
2. Add a cohort accountability table template (included, excluded, reason codes) mirroring the clarity seen here.
3. Tighten endpoint timing definitions (baseline and post-index windows) to reduce ambiguity in EHR-derived outcomes.
4. Pre-specify primary and supportive estimands with explicit decision thresholds and sensitivity plans.
5. Include a dedicated "regulatory traceability" subsection documenting protocol versioning, SAP lock, and auditability of analysis artifacts.

## Candidate language for protocol discussion section

Recent FDA device precedent in psychiatry (BrainsWay Deep TMS, 510(k) K251391, 2025) demonstrates acceptance of a pre-specified retrospective RWD analysis to support an adolescent MDD label expansion. While not directly transferable to drug substantial-evidence standards, this decision reinforces core RWE expectations central to the present protocol: fit-for-purpose data capture, explicit cohort construction rules, prespecified analytic criteria, and transparent reporting of analysis populations and outcomes.

## Crosswalk to `draft.md`

| Content from this memo | Purpose in protocol | Primary insertion point in `draft.md` | Secondary insertion point in `draft.md` |
|---|---|---|---|
| FDA decision synopsis (K251391, adolescent adjunct indication, 510(k) context) | Brief regulatory precedent framing | `1.5 Regulatory and Methodological Framework` | `1.1 Background and Rationale` |
| Evidence package details (multi-center RWD, pre-defined protocol, eligibility, endpoints) | Show what "fit-for-purpose and prespecified" looked like in a recent FDA decision | `1.4 Data Sources` | `1.5 Regulatory and Methodological Framework` |
| Pillar A implications (data provenance, cohort construction, missingness/attrition transparency) | Tighten RWD quality and cohort traceability requirements | `2.5 Analysis Sets` | `4.1 Subject Disposition` |
| Endpoint timing clarity (baseline and post-index windows) | Reduce ambiguity in outcome ascertainment windows | `2.1 Index Date and Study Periods` | `2.2 Baseline Assessment Definition` |
| Prespecified responder/success criteria concept | Clarify decision-linked thresholds and interpretability | `3.2 Statistical Hypotheses` | `5.1 General Analysis Specifications` |
| Estimand and TTE alignment language | Ensure study question, design, and analysis remain coherent | `3.1 Estimands` | `1.3 Study Design` |
| Sensitivity and robustness expectations | Anticipate reviewer questions on assumptions and stability | `3.6 Sensitivity Analyses` | `5.5 Sensitivity Analyses` |
| Cohort accountability table recommendation (included/excluded with reason codes) | Improve reproducibility and auditability of sample derivation | `4.1 Subject Disposition` | `Appendix C1. Tables` |
| Regulatory traceability recommendation (protocol versioning, SAP lock, artifact audit trail) | Demonstrate disciplined conduct and change control | `4.7 Deviations from Pre-specified Analysis Plans` | `1.5 Regulatory and Methodological Framework` |
| Candidate discussion paragraph (methodological relevance, limits of analogy) | Add balanced precedent language without over-claiming transferability | `1.5 Regulatory and Methodological Framework` | `Executive Summary` |

## Source used

- `src/tms_example.pdf` (FDA clearance letter, indications for use form, and 510(k) summary for K251391)
