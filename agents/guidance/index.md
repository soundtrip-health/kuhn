# Advisor Knowledge Base — Master Index

This is the entry point for the advisor agent's knowledge base. It organizes source documents and structured summaries by project type, allowing the advisor to accumulate domain expertise across projects.

The PI may add source documents at any time by placing them in the appropriate `<project-type>/src/` directory and notifying the advisor. The advisor creates structured summaries and updates this index.

---

## Knowledge Base Branches

| Branch | Path | Status | Description |
|--------|------|--------|-------------|
| [RWE Protocol](#rwe-protocol) | `rwe-protocol/` | Active | FDA Real-World Evidence study protocols |
| [RCT Protocol](#rct-protocol) | `rct-protocol/` | Placeholder | FDA Randomized Clinical Trial protocols |
| [Grant Application](#grant-application) | `grant-application/` | Placeholder | NIH, SBIR, and bespoke grant applications |
| [Manuscript](#manuscript) | `manuscript/` | Placeholder | Scientific manuscripts and journal articles |
| [SOP](#sop) | `sop/` | Placeholder | Standard Operating Procedure documents |
| [Shared](#shared-cross-cutting-references) | `shared/` | Placeholder | Cross-cutting statistical and methodological references |

---

## RWE Protocol

FDA guidance documents and references for designing Real-World Evidence studies. Three durable regulatory principles anchor all decisions:

- **A)** Whether the RWD are fit for use
- **B)** Whether the study design can provide adequate scientific evidence
- **C)** Whether study conduct meets FDA regulatory requirements

### FDA Real-World Evidence Program

#### RWE Program Framework

- **Source:** [src/framework.pdf](src/framework.pdf)
- **Citation:** U.S. FDA. *Framework for FDA's Real-World Evidence Program.* December 2018.
- **Key concepts:** Overarching RWD/RWE framework; the three durable regulatory principles (data fitness, study design adequacy, regulatory compliance); FDA's goals for incorporating RWD into regulatory decision-making.
- **Structured summary:** [TODO: advisor to create]

#### Assessing EHRs and Medical Claims Data

- **Source:** [src/assessing.pdf](src/assessing.pdf)
- **Citation:** U.S. FDA, CDER/CBER/OCE. *Real-World Data: Assessing Electronic Health Records and Medical Claims Data to Support Regulatory Decision-Making for Drug and Biological Products.* July 2024.
- **Key concepts:** Data source relevance and enrollment comprehensiveness; data linking across sources; unstructured EHR data considerations; missingness and data fitness; variable definitions and validation.
- **Structured summary:** [TODO: advisor to create]

#### Non-Interventional Study Considerations

- **Source:** [src/considerations.pdf](src/considerations.pdf)
- **Citation:** U.S. FDA, CDER/CBER/OCE. *Real-World Evidence: Considerations Regarding Non-Interventional Studies for Drug and Biological Products (Draft).* March 2024.
- **Key concepts:** Minimum expectations for substantial evidence from non-interventional studies; prespecification requirements; relationship to durable principle B (study design adequacy).
- **Structured summary:** [TODO: advisor to create]

### Study Design and Target Trial Emulation

#### Target Trial Emulation Design Review

- **Source:** [src/tte_design_2026.pdf](src/tte_design_2026.pdf)
- **Key concepts:** Comprehensive review of the TTE framework; design and implementation principles for emulating randomized trials with observational data; common pitfalls and best practices.
- **Structured summary:** [TODO: advisor to create]

#### EQUIV Protocol (Target Trial)

- **Source:** [src/EQUIV.pdf](src/EQUIV.pdf)
- **Key concepts:** Protocol for the EQUIV study demonstrating non-inferiority and comparative effectiveness of IV ketamine vs. intranasal esketamine for treatment-resistant depression; serves as the target trial for our TTE framework.
- **Structured summary:** [TODO: advisor to create]

#### TMS Label Expansion for MDD (Regulatory Precedent)

- **Source:** [src/tms_example.pdf](src/tms_example.pdf)
- **Summary:** [src/tms_mdd_rwe.md](src/tms_mdd_rwe.md)
- **Key concepts:** FDA 510(k) clearance using real-world data; demonstrates FDA acceptance of pre-specified retrospective analysis with protocolized RWD collection.
- **Structured summary:** [TODO: advisor to create]

#### EMA Example Documentation

- **Source:** [src/ema_example.pdf](src/ema_example.pdf)
- **Key concepts:** European Medicines Agency regulatory example; comparative context for non-FDA regulatory pathways.
- **Structured summary:** [TODO: advisor to create]

### Non-Inferiority Design and Statistical Methodology

#### Non-Inferiority Clinical Trials Guidance

- **Source:** [src/non-inferior-guidance.pdf](src/non-inferior-guidance.pdf)
- **Citation:** U.S. FDA, CDER/CBER. *Non-Inferiority Clinical Trials to Establish Effectiveness.* November 2016.
- **Key concepts:** Prespecification and justification of NI margins (M1 and M2); HESDE; constancy assumption; bias control toward false non-inferiority; CI decision logic.
- **Structured summary:** [TODO: advisor to create]

#### Statistical Principles — Estimands and Sensitivity Analyses

- **Source:** [src/stats-principles-estimands-sensitivity.pdf](src/stats-principles-estimands-sensitivity.pdf)
- **Key concepts:** ICH E9(R1) estimand framework; intercurrent event handling strategies; sensitivity analysis principles for confirmatory clinical trials.
- **Note:** This reference is cross-cutting — relevant to RWE protocols, RCT protocols, and manuscripts reporting clinical trial results. Consider linking from `shared/` as well.
- **Structured summary:** [TODO: advisor to create]

### MDD Drug Development Guidance

#### FDA MDD Drug Development Guidance

- **Source:** [../research/litreview/Major-Depressive-Disorder---Developing-Drugs-for-Treatment.pdf](../research/litreview/Major-Depressive-Disorder---Developing-Drugs-for-Treatment.pdf)
- **Citation:** U.S. FDA, CDER. *Major Depressive Disorder: Developing Drugs for Treatment (Draft Guidance, Revision 1).* June 2018.
- **Key concepts:** TRD definition (>= 2 prior antidepressants), NI design limitations for antidepressants, accepted primary endpoints (HAM-D, MADRS, CDRS), rapid-acting antidepressant assessment windows, study population requirements.
- **Structured summary:** [TODO: advisor to create]

### Protocol Evaluation Tools

#### RWE Protocol Evaluation Review

- **Source:** [src/rwe-protocol-eval-review.html](src/rwe-protocol-eval-review.html)
- **Key concepts:** Interactive evaluation tool for assessing RWE protocol quality and completeness.
- **Structured summary:** [TODO: advisor to create]

### Cross-References (RWE)

| Topic | Primary source | Related sources |
|-------|---------------|-----------------|
| Data fitness (Pillar A) | Assessing EHRs | RWE Framework |
| Study design adequacy (Pillar B) | Non-Interventional Studies | TTE Design, EQUIV |
| NI margin and analysis | NI Guidance | Estimands, MDD Guidance (NI limitations) |
| TRD definition and endpoints | MDD Guidance | EQUIV |
| Regulatory precedent for RWE | TMS Label Expansion | Non-Interventional Studies |

---

## RCT Protocol

*No sources yet.* Relevant materials for this branch include:
- ICH E6(R2) Good Clinical Practice guidelines
- ICH E8(R1) General Considerations for Clinical Studies
- ICH E9 Statistical Principles for Clinical Trials
- FDA-specific therapeutic area guidance
- SPIRIT 2013 checklist for protocol items
- CONSORT 2010 reporting guidelines

Place source documents in `rct-protocol/src/` and notify the advisor.

---

## Grant Application

*No sources yet.* Relevant materials for this branch include:
- NIH Grants Policy Statement (current fiscal year)
- SF 424 (R&R) Application Guide
- SBIR/STTR Program Policy Directive
- Funder-specific RFAs, PAs, or application instructions
- NIH review criteria and scoring rubrics

Place source documents in `grant-application/src/` and notify the advisor.

---

## Manuscript

*No sources yet.* Relevant materials for this branch include:
- Target journal author guidelines (Instructions for Authors)
- ICMJE Recommendations (Uniform Requirements)
- Reporting guidelines (CONSORT, STROBE, PRISMA, ARRIVE, etc.)
- Field-specific style guides

Place source documents in `manuscript/src/` and notify the advisor.

---

## SOP

*No sources yet.* Relevant materials for this branch include:
- Applicable regulatory standards (21 CFR Part 11, GxP, ISO 9001, etc.)
- Industry-specific guidance documents
- Internal quality management system requirements
- Template SOPs from relevant regulatory bodies

Place source documents in `sop/src/` and notify the advisor.

---

## Shared (Cross-Cutting References)

References that apply across multiple project types — statistical methods, general research methodology, writing conventions.

*No shared sources yet.* Candidates for this section:
- ICH E9(R1) estimand framework (currently in RWE branch — consider linking)
- General statistical references (power analysis, multiple comparisons, Bayesian methods)
- Research integrity guidelines (COPE, ORI)
- Scientific writing style guides (AMA, APA, CSE)

Place source documents in `shared/src/` and notify the advisor.
