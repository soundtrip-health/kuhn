# Model Cards for Model Reporting (Mitchell et al., 2019)

> **Kuhn knowledge card.** Canonical source: https://arxiv.org/abs/1810.03993 (arXiv; peer-reviewed version in Proceedings of FAT*/FAccT 2019, ACM). Source access/license: free, open-access preprint (arXiv, with authors' distribution license). This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

"Model Cards for Model Reporting" proposes a short, standardized document — a **model card** — that accompanies any released or deployed trained machine-learning model. It is the model-side companion to Datasheets for Datasets. The framework applies to models of every kind (classifiers, regressors, generative models, embeddings, APIs) and every release mode (open weights, hosted API, internal deployment, paper artifact).

Its central move is to require **evaluation disaggregated across relevant demographic, cultural, and environmental groups**, so users can see not just aggregate accuracy but for whom and under what conditions the model works. Modern ecosystem practice (e.g., model cards on model hubs, cards attached to large-model releases) descends directly from this paper.

## Key requirements

The proposed model card has nine sections, paraphrased:

- **Model details.** Who developed the model and when; version and type (architecture, algorithm family); training details relevant to use (features, objective, fairness constraints applied); license; citation; where to send questions.
- **Intended use.** The use cases the model was designed and evaluated for; intended users; and — explicitly — **out-of-scope uses**: applications the developers did not evaluate or consider inappropriate, stated concretely enough to steer users away.
- **Factors.** The dimensions along which performance may vary and along which evaluation should be disaggregated: demographic or phenotypic groups (e.g., age, gender, skin type), environmental conditions (lighting, recording quality), and instrumentation (camera/microphone type). The card should say which factors are *relevant* and which were actually *evaluated*.
- **Metrics.** Which performance measures are reported and why they fit the use (e.g., false-positive vs false-negative costs), decision thresholds used, and how variation/uncertainty was estimated (confidence intervals, repeated runs).
- **Evaluation data.** The datasets used for the reported evaluation, why they were chosen, and any preprocessing; ideally including data the developers did not control.
- **Training data.** As much as can be disclosed about the training data's source and distribution (mirroring datasheet content); when proprietary, at minimum describe distributions over relevant factors.
- **Quantitative analyses.** The core tables and figures, reported two ways:
  - *unitary* results — each metric computed for each relevant factor group separately;
  - *intersectional* results — metrics across combinations of factors (e.g., performance by gender × skin type), so disparities that aggregate metrics hide become visible.
- **Ethical considerations.** Sensitive data used, risks to human life or safety, mitigations applied, known risky use cases, and residual concerns.
- **Caveats and recommendations.** Anything else users should know: gaps in evaluation coverage, groups not represented, recommendations for further testing before deployment in new contexts.

### When to include one

Include a model card whenever a trained model leaves its authors' hands or decisions depend on it:

- public releases and model-hub uploads;
- hosted APIs and models shipped inside products;
- models described in papers — attach the card as an appendix or supplementary artifact;
- regulated or high-stakes deployments (hiring, credit, health, safety);
- fine-tunes and adaptations — the card can inherit from the base model's card while documenting the new training data, the changed intended use, and freshly re-run disaggregated evaluations.

## How to apply when writing

- Treat the nine headings as a template: draft the card as a standalone 1–2 page document (or paper appendix) with those sections in order; brevity plus completeness beats prose.
- Write intended use and out-of-scope use as parallel lists — reviewers and users read the out-of-scope list first; vague disclaimers ("not for misuse") don't satisfy the section.
- Choose factors *before* running the evaluation and justify them from the deployment context; then report every metric per group and for key intersections, with confidence intervals so small subgroups aren't over-read.
- State the decision threshold for any thresholded metric, and report performance across thresholds if deployment thresholds may differ.
- In a paper's methods/experiments section, cite the model card for details ("full disaggregated results in the model card, Appendix B") rather than duplicating; keep the card versioned alongside the model version it describes.
- If training data cannot be disclosed, say so explicitly and describe its distribution over the relevant factors — silence reads as omission, not confidentiality.

## Common pitfalls

- Reporting only aggregate metrics — the disaggregated (and intersectional) analysis is the point of the framework.
- Omitting out-of-scope uses, or writing them so generically that no real application is excluded.
- No version/date on the card, so it silently describes a different model than the one deployed.
- Evaluation data identical in provenance to training data, leaving generalization to new conditions unexamined.
- Treating the ethical-considerations section as boilerplate rather than naming the specific sensitive attributes, risks, and mitigations for *this* model.
- Copying a base model's card for a fine-tuned model without re-running the quantitative analyses.
- Writing the card once at launch and never updating it as thresholds, training data, or deployment context change.

## Canonical links

- Model Cards for Model Reporting (arXiv, canonical): https://arxiv.org/abs/1810.03993
- ACM FAT* 2019 proceedings version (DOI): https://dl.acm.org/doi/10.1145/3287560.3287596
- Companion framework — Datasheets for Datasets: https://arxiv.org/abs/1803.09010
