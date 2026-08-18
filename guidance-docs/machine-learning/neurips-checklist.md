# NeurIPS Paper Checklist — De-facto ML Reproducibility Standard

> **Kuhn knowledge card.** Canonical source: https://neurips.cc/public/guides/PaperChecklist (NeurIPS — Neural Information Processing Systems Conference). Source access/license: free, public conference guidelines; the checklist is mandatory for NeurIPS submissions and is republished each cycle. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

The NeurIPS paper checklist is a mandatory, self-completed questionnaire appended to every NeurIPS submission. Each item takes a Yes / No / Not-Applicable answer **plus a justification pointing to where in the paper the item is addressed** — answers are visible to reviewers and, for accepted papers, published with the paper.

Introduced as a broader-impact requirement in 2020 and formalized as a checklist in 2021, it has become the **de-facto reproducibility and transparency standard for machine-learning papers generally**: other venues (ICML, ICLR, AAAI variants) and many journal/preprint authors use it or derivatives even when not required. It applies to all ML paper types — theory, methods, benchmarks, datasets, applications — with N/A as the honest answer where a theme doesn't apply (e.g., compute for a pure-theory paper).

## Key requirements

The checklist items group into recurring theme areas, paraphrased:

- **Claims.** The abstract and introduction must accurately state the paper's contributions and scope; claims must match the theoretical and experimental results, and generalization beyond the evidence must be flagged as aspiration, not finding.
- **Limitations.** An explicit discussion of limitations: assumptions and their fragility, settings where performance may degrade, scope of validity of results, and factors (data, compute, privacy) that bounded the evaluation. NeurIPS treats a candid limitations section as a norm, not a weakness.
- **Theory.** Every theoretical result states its full set of assumptions, and complete, correct proofs appear in the paper or supplement, with proof sketches cross-referenced.
- **Experimental reproducibility.** The paper (plus supplement) must disclose everything needed to reproduce the main results: model architectures, algorithms, training and evaluation procedures, hyperparameters and how they were chosen, data splits, and any details relegated to appendices but essential to replication.
- **Code and data access.** Open access to code and data with exact instructions to reproduce the main results is the expectation.
  - Where release is impossible (proprietary data, safety concerns), the paper must say so and provide what it can — e.g., an anonymized repository at submission, released on acceptance.
- **Experimental rigor / statistical significance.** Report error bars, confidence intervals, or other variability measures for main results, stating what randomness they capture (seeds, splits, initializations) and how they were computed.
  - Report the number of runs, and avoid claiming improvements that lie within noise.
- **Compute resources.** State the compute used per experiment and in total: hardware type (GPU/TPU/CPU), memory, and wall-clock or GPU-hours.
  - Ideally include failed and preliminary runs, so others can assess the true feasibility and cost of the research.
- **Existing assets and licensing.** Cite the creators of datasets, code, and models used; state versions and licenses and honor their terms; document any scraped or third-party content.
- **New assets.** New datasets/models released with the paper need documentation (datasheet/model-card-style), license, and access details.
- **Human subjects and annotators.** For crowdsourcing or human-subject studies: disclose the instructions given to participants (with screenshots where relevant).
  - Disclose compensation (at least local minimum-wage expectations) and IRB or equivalent ethics-approval status.
- **Ethics and societal impact.** Conformance with the NeurIPS Code of Ethics is asserted for every submission.
  - Discuss foreseeable positive and negative societal impacts (misuse, fairness, privacy, security) where relevant.
  - Describe safeguards for high-risk releases — e.g., staged release of models with misuse potential, filters for generated content.
- **LLM usage (recent cycles).** Declare whether large language models were an important, original, or non-standard component of the core methodology (usage for writing/editing needs no declaration; methodological use must be described).

## How to apply when writing

- Draft against the checklist from the start: keep a running answers file, and write Methods/Experiments so each answer can point to a concrete section, table, or appendix — "Yes, see §4.2 and App. C".
- Put a real Limitations subsection in the paper (not only in the checklist), covering assumptions, failure modes, and external validity.
- For every headline result table: state number of seeds/runs, what the ± denotes (std dev, std err, 95% CI), and the split protocol; tie any "outperforms" claim to a variability-aware comparison.
- Create a reproducibility appendix: full hyperparameters (search space and final values), training schedule, hardware, and total compute; add a code/data availability paragraph with URL and license.
- For datasets and models you release, attach datasheet/model-card documentation and a license; for assets you use, cite version + license in the paper, not just the repo README.
- Answer honestly — "No, because…" with a good reason is acceptable and reviewed as such; a bare unjustified "Yes" that the paper doesn't support is treated as a claims problem.
- Answer the LLM item accurately: methodological LLM use (agents, judges, synthetic-data generation) belongs in Methods, not only in the checklist declaration.
- Outside NeurIPS, the same structure works as a pre-submission audit for any ML manuscript: claims ↔ evidence, limitations, reproducibility disclosure, compute, licensing, ethics.

## Common pitfalls

- Checklist answers that don't point anywhere in the paper, or "Yes" answers contradicted by missing appendices.
- Error bars absent, or present without saying what randomness they capture or how many runs they summarize.
- Hyperparameter search protocol omitted — reporting only final values hides the tuning budget that drove the result.
- Compute reported vaguely ("trained on GPUs") or omitting total/failed-run cost.
- Using datasets or pretrained models without stating version and license, or releasing derivatives that violate the upstream license.
- Answering N/A to items that plainly apply (e.g., safeguards for a released generative model, or licenses for scraped data).
- Boilerplate limitations/impact statements that name no concrete assumption, failure mode, or risk.

## Canonical links

- NeurIPS Paper Checklist guidelines (canonical): https://neurips.cc/public/guides/PaperChecklist
- NeurIPS 2021 checklist (foundational format): https://neurips.cc/Conferences/2021/PaperInformation/PaperChecklist
- NeurIPS Code of Ethics: https://neurips.cc/public/EthicsGuidelines
- NeurIPS LLM usage policy: https://neurips.cc/Conferences/2025/LLM
