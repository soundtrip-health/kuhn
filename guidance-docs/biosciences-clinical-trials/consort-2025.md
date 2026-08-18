# CONSORT 2025 — Reporting Randomized Controlled Trials

> **Kuhn knowledge card.** Canonical source: https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.1004587 (PLOS Medicine / CONSORT Collaboration). Source access/license: free, open-access (published simultaneously in PLOS Medicine, BMJ, JAMA, Lancet, Nature Medicine); DOI 10.1371/journal.pmed.1004587. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

CONSORT (Consolidated Standards of Reporting Trials) 2025 defines the minimum information a published report of a **randomized controlled trial (RCT)** must contain for readers to judge its design, conduct, analysis, and interpretation. It applies to journal articles reporting the main results of parallel-group RCTs of any intervention (drug, device, behavioral, surgical, digital). Extensions in the CONSORT family adapt it to other designs (cluster, crossover, non-inferiority, multi-arm, AI interventions). CONSORT 2025 replaces the CONSORT 2010 statement. For trial *protocols* (rather than results), use the companion SPIRIT 2025 guideline; for systematic reviews, use PRISMA 2020.

## Key requirements

CONSORT 2025 is a 30-item checklist organized by manuscript section, plus a mandatory participant flow diagram. Paraphrased by section:

- **Title and abstract.** The title must identify the study as a randomized trial. The abstract must be a structured trial summary (design, methods, results, conclusions) with its own abbreviated checklist — including numbers randomized and analyzed, the primary-outcome result with effect size and precision, harms, registration number, and funding.
- **Open science (new emphasis in 2025).** Report the trial registry and registration number, where the full protocol and statistical analysis plan can be accessed, and the availability of de-identified participant data, statistical code, and materials. Report funding sources, the funder's role, and investigators' conflicts of interest — these moved forward in prominence compared with 2010.
- **Introduction.** Scientific background, rationale for the trial, and explicit objectives concerning a specified population, interventions, and outcomes.
- **Methods — design and participants.** Describe the trial design (allocation ratio, framework such as superiority or non-inferiority), any changes to methods after the trial began, eligibility criteria, and the settings and locations of data collection.
- **Methods — interventions.** Describe interventions and comparators in enough detail for replication, following TIDieR (materials, procedures, who delivered them, how, where, how often, tailoring, and fidelity). CONSORT 2025 formally integrates TIDieR here.
- **Methods — outcomes.** Define all prespecified primary and secondary outcomes, including the measurement variable, analysis metric, aggregation method, and time point; report any outcome changes after trial start with reasons.
- **Methods — sample size.** Explain how the sample size was determined, plus any interim analyses and stopping guidelines.
- **Methods — statistical methods.** Describe statistical methods for primary and secondary outcomes, the analysis population (with an estimand-style description of how intercurrent events and missing data were handled), and methods for additional analyses (subgroups, adjustment), noting which were prespecified.
- **Methods — randomization and blinding.** Describe sequence generation (including type of randomization and any restriction such as blocking or stratification), the allocation-concealment mechanism, who generated, enrolled, and assigned, and who was blinded (participants, care providers, outcome assessors, analysts) with how blinding was achieved.
- **Results — participant flow and recruitment.** Report participant flow (screened where available, randomized, received intervention, followed up, analyzed) with reasons for losses and exclusions — normally as the CONSORT flow diagram — plus recruitment dates and why the trial ended or stopped.
- **Results — outcomes.** Report baseline characteristics by group, numbers analyzed per group, and for each primary and secondary outcome, results per group with estimated effect size and its precision (e.g., 95% CI), giving both absolute and relative effects for binary outcomes.
- **Harms.** Report all important harms or unintended effects per group, with how harms information was collected — an area substantially strengthened in 2025.
- **Discussion.** Trial limitations (bias, imprecision, multiplicity), generalizability, and an interpretation consistent with the results that balances benefits and harms and considers other relevant evidence.
- **Patient and public involvement (new in 2025).** State whether and how patients or the public were involved in the design, conduct, or dissemination of the trial.

### What changed vs CONSORT 2010

- Reorganized into 30 items with a new "Open science" cluster: registration, protocol/SAP access, data and code sharing, funding, and conflicts of interest are now front-and-center reporting obligations.
- TIDieR intervention-description items are folded directly into the checklist rather than referenced as an optional extension.
- Harms reporting expanded from a single item into fuller expectations for collection methods and per-group presentation (absorbing the former harms extension).
- New item on patient and public involvement.
- Outcome definitions and analysis-population descriptions tightened, reflecting the ICH E9(R1) estimand framework (state how intercurrent events and missing data were handled).
- Abstract checklist updated; flow diagram retained with clarified expectations for reporting the screened population when known.

## How to apply when writing

- Draft the Methods and Results sections *against the checklist*: walk item-by-item and confirm each has a specific sentence in the manuscript. Many journals require a completed checklist with page numbers at submission.
- Build the flow diagram from the trial database before writing Results; the diagram's numbers (randomized, received allocation, lost, analyzed, per arm) must match every table and the abstract exactly.
- Write the primary-outcome sentence in canonical form: point estimate, 95% confidence interval, and per-group summaries — never a bare p-value. For binary outcomes give both absolute (risk difference) and relative (risk ratio / odds ratio) effects.
- State the registry ID (e.g., NCT number) in the abstract and methods; link the protocol and SAP; include a data-availability statement even if the answer is "not available," with the reason.
- Describe randomization in three separable pieces — sequence generation, allocation concealment, implementation — plus a distinct blinding statement listing exactly who was blinded.
- Label every non-prespecified analysis as post hoc, and reconcile the reported outcomes against the registry entry before submission.

## Common pitfalls

- Reporting only relative effects for binary outcomes, or p-values without effect sizes and confidence intervals.
- Flow-diagram numbers that disagree with the analysis tables or abstract.
- Conflating allocation concealment with blinding, or saying "double-blind" without stating who was blinded.
- Silent outcome switching: primary outcome in the paper differs from the registry/protocol without explanation.
- Under-reporting harms (e.g., only "no serious adverse events" with no collection method or denominators).
- Intervention descriptions too thin to replicate — missing dose/intensity, provider, delivery mode, or fidelity assessment.

## Canonical links

- CONSORT 2025 statement (canonical, open access): https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.1004587
- CONSORT website (checklist downloads, extensions): https://www.consort-statement.org/
- EQUATOR Network guideline directory: https://www.equator-network.org/reporting-guidelines/
- Companion protocol guideline (SPIRIT 2025): https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(25)00770-6/fulltext
