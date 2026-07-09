# FDA RWE frameworks & the briefing-book genre

Generic FDA regulatory practice for real-world-evidence submissions and the
briefing-book document genre. This is product-level, public guidance. (Any
tenant-specific worked example — how these lessons landed for a particular client
on a particular data source — belongs in that tenant's KB, not here.)

## FDA Real-World Evidence program — the three pillars

Every data-related claim in an RWE submission should be readable against three
questions:

- **A) Fit-for-use** — Are the real-world *data* fit for the regulatory question?
  (completeness, accuracy, provenance, variable validation for
  exposure/outcome/covariates, temporal alignment, linkage.)
- **B) Adequate design** — Does the proposed RWE *study design* provide scientific
  evidence adequate to support the regulatory decision? (estimand, comparator,
  bias/confounding control, sensitivity analyses.)
- **C) Regulatory conduct** — Does (or will) study *conduct* meet FDA expectations
  for **prespecification, provenance, transparency, and auditability**? (protocol +
  SAP submitted before analysis; data "analyzed for the first time"; reproducible
  pipeline.)

*Drafting test:* tag each RWE section with which pillar(s) it answers; a section that
answers none is probably narrative filler.

### Core guidance documents

| Document | Cite as | Use for |
|---|---|---|
| RWE Program Framework | U.S. FDA. *Framework for FDA's Real-World Evidence Program.* Dec 2018. | Establishes the three pillars; cite when framing any RWE argument. |
| Assessing EHRs & Medical Claims Data | U.S. FDA (CDER/CBER/OCE). *Real-World Data: Assessing EHRs and Medical Claims Data…* Jul 2024. | Spine of a data-fitness (Pillar A) section. |
| Non-Interventional Study Considerations (Draft) | U.S. FDA. *…Considerations Regarding Non-Interventional Studies… (Draft).* Mar 2024. | Minimum expectations for substantial evidence from NIS; prespecification; data-source selection; causal-inference approach (Pillar B/C). |
| Integrating RCTs Into Routine Clinical Practice (Draft) | U.S. FDA. *…(Draft).* Sep 2024. Docket FDA-2024-D-2052. | A real RCT embedded in routine practice using EHRs — a pragmatic-RCT pathway. Note the explicit allowance for unapproved drugs with well-characterized class safety when consulted with the division. |
| Non-Inferiority Clinical Trials | U.S. FDA (CDER/CBER). *Non-Inferiority Clinical Trials to Establish Effectiveness.* Nov 2016. | Only if a design is framed as NI (M1/M2, constancy, bias-toward-NI). FDA may not accept NI framing for an RWE supplement — apply selectively. |
| Statistical Principles — Estimands & Sensitivity | ICH E9(R1). | Estimand definition and intercurrent-event handling for the SAP (see `shared/estimand-framework-and-tte.md`). |

> **Draft-guidance discipline.** Several of the above are drafts in public comment.
> Cite with the draft caveat and the docket number; positions can shift.

## FDA briefing book — genre, structure, and presenting RWE

An FDA briefing book is a **formal regulatory document addressed to the FDA review
division**, written to support a specific meeting and elicit specific agreements — not
an internal proposal, pitch deck, or collaborator conversation. Five genre markers:

1. **Audience is FDA; voice is the Sponsor** — third person throughout ("Sponsor
   proposes…", "Does FDA agree…?"). No "we have been discussing," no addressing a
   commercial partner. A named data vendor is the *data source*, never the speaker.
2. **Organized to produce decisions** — the document builds toward **numbered
   Questions**, each a crisp agreement-seeking ask ("Does the Division agree that…?").
   Evidence sections exist to support those questions.
3. **Regulatory front matter** — application/IND number, product, indication, sponsor,
   pathway, meeting type/category/date, attendee tables.
4. **Every claim anchored to an authority** — named FDA guidance (title + date +
   docket), prior minutes/advice letters (by date), CFR citations, literature.
5. **Formal, restrained register** — no rhetorical asides, no cost-savings selling
   points. Confidence comes from precision and citation, not enthusiasm.

**Presenting RWE inside a briefing book.** RWE is not prose paragraphs — it is
presented as **structured appendices** a reviewer can audit:

- **Protocol Synopsis + Statistical Analysis Plan** using the canonical synopsis
  skeleton (Title/Indication/Type of Analysis; Background and Rationale; numbered
  Analysis Objectives, each operationally defined; named Study Design, e.g. target
  trial emulation; Data Sources + an explicit data-quality-assessment statement;
  Patient Selection as inclusion/exclusion; Time-related Variables; Exposure and
  Comparator; Outcome Assessments; Analysis Sets; Bias and Confounding Control;
  Statistical Methods; a standalone SAP block — A1 Estimand (ICH E9(R1)), A2 Primary
  Analysis, A3 Secondary, A4 Covariates, A5 Missing-Data Handling, A6
  Sensitivity/Robustness; References).
- **Data Overview appendix** — a factual catalog letting the reviewer judge fitness:
  patient and treatment counts; counts of each fit-for-purpose scale measure; the
  structured note-template fields captured; the demographics/diagnoses/medications/
  history data model. This converts "trust us" into auditable fitness evidence.

**When the ask is only a meeting.** Sometimes the ask is narrow and procedural
("grant us a meeting to align on standards"). Discipline: make the body a single clean
ask; relocate detailed questions to an appendix explicitly marked "not seeking written
answers now"; present worked examples as illustrative, not commitments; frame
standards as properties of the indication and the data, not the molecule
(molecule-agnostic — align once on instrument fitness, safety measurement, and
data-quality/conduct standards).

**Checklist when drafting or auditing a briefing book.** Voice is Sponsor → FDA, third
person, no vendor-pitch language; ends in numbered agreement-seeking Questions;
regulatory front matter present; every claim anchored; RWE as synopsis + standalone
SAP + data-overview appendix; primary endpoint on the most defensible instrument;
explicit offer to submit protocol + SAP before analysis; cohort prespecified and
indication-restricted; Safety Analysis Set tied to structured actively-captured
fields; register formal and restrained; if the ask is only a meeting, the body is a
single clean request with detailed questions in a "not-for-written-answer" appendix;
worked examples framed as illustrative.
