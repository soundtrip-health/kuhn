# SAMPL Guidelines: Statistical Analyses and Methods in the Published Literature

> **Kuhn knowledge card.** Canonical source: https://www.equator-network.org/reporting-guidelines/sampl/ (EQUATOR Network; Lang & Altman 2013/2015). Source access/license: freely accessible via EQUATOR; the article text is publisher-copyrighted — this card paraphrases the guidance by analysis type. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

SAMPL ("Statistical Analyses and Methods in the Published Literature") by Tom Lang and Douglas Altman gives journal-agnostic rules for reporting **statistical methods and results** — the statistics layer that design-specific guidelines (CONSORT, STROBE, PRISMA) assume but do not spell out.

It applies to any quantitative manuscript in biomedical, social, or environmental science: descriptive summaries, hypothesis tests, regression and ANOVA-type models, survival and Bayesian analyses. Its governing purpose: a knowledgeable reader, given access to the data, could verify every reported result.

SAMPL complements rather than replaces design-level guidelines: use it alongside CONSORT for trials, STROBE for observational studies, or JARS for psychology, as the checklist for the statistics themselves. Journals rarely enforce SAMPL by name, but statistical reviewers apply its expectations routinely.

## Key requirements

**General principles.** Describe methods in enough detail to allow re-analysis:

- Identify each statistical procedure and the software (with version) used; state the purpose of each analysis and which variables it involved.
- Report how assumptions were checked and how violations were handled.
- Distinguish prespecified from exploratory analyses; account for multiple comparisons.
- Describe handling of missing data and outliers.
- Give exact p-values with the test statistic and degrees of freedom; pair estimates with confidence intervals.
- Use appropriate numerical precision (no more decimals than measurement supports) and make every denominator identifiable.

**By analysis type, paraphrased:**

- *Descriptive statistics:* summarize approximately normal variables with mean and standard deviation, skewed variables with median and interquartile range; never use standard error as a descriptive spread measure, and never write "mean ± x" without naming which spread measure follows the sign. Report counts with percentages (and denominators) for categorical data.
- *Hypothesis tests:* name the test, state whether it is one- or two-tailed (and justify one-tailed), confirm the test's assumptions were met, report the exact p-value, and accompany the comparison with an effect estimate and its confidence interval — the difference itself matters more than the verdict.
- *Correlation and association:* name the coefficient (Pearson, Spearman), give its value with a confidence interval, and avoid presenting correlation as causation or reporting p alone.
- *Regression (linear, logistic, and similar models):* state the model and outcome; how predictors were chosen and coded; how continuous variables were treated (linearity checks, any categorization); coefficients with standard errors or confidence intervals; goodness-of-fit or model diagnostics; whether the model was validated; and events-per-variable adequacy for logistic models.
- *ANOVA-type analyses:* the factors and their levels, interaction terms examined, and post-hoc/multiple-comparison procedures with the adjustment method.
- *Survival analyses:* how time zero and events were defined, censoring rules, the estimation method (e.g., Kaplan–Meier), comparison test (e.g., log-rank), hazard ratios with intervals, and verification of the proportional-hazards or equivalent assumption.
- *Bayesian analyses:* the priors and their justification, the model, the software/algorithm, convergence checks, and posterior summaries with credible intervals.

**Presentation.** Figures and tables must be self-sufficient: complete captions, labeled axes with units, variability shown on plots, and no duplication of the same numbers across text, table, and figure.

## How to apply when writing

- **Methods — statistical analysis subsection:** one paragraph per analysis family: purpose → variables → model/test → assumption checks → missing-data handling → software and version → significance criteria and any multiplicity adjustment. Add a sentence distinguishing prespecified from exploratory analyses.
- **Results:** for each comparison write estimate first, uncertainty second, p last: "difference 3.1 units (95% CI 0.8–5.4), t(48) = 2.7, p = 0.009." Match every result in Results to a method in Methods — no orphan analyses in either direction.
- **Precision:** round sensibly (usually two significant figures for p, one decimal beyond the measurement precision for means); report percentages with numerators and denominators (34/120, 28%).
- **Tables:** summarize model output with coefficient, CI, and p per row; state the N used in each model, since missing data can shrink it.
- **Missing data:** say how much was missing, for which variables, and what was done (complete case, imputation method) — once, prominently, in Methods.
- **Verification mindset:** before submission, check that a reader could recompute each statistic from what is reported (group sizes, summary statistics, test statistics, df).

## Common pitfalls

- Mean ± SE presented as if it described data spread, or "±" with no statement of what follows it.
- "p < 0.05" or "NS" instead of exact p-values; p-values without the test statistic or effect estimate.
- Unnamed or default-software analyses ("statistics were performed in SPSS") with no test identified per result.
- Stepwise variable selection reported without acknowledgment, or regression models with no diagnostics or fit statistics.
- Missing data never mentioned — Ns silently differing between tables.
- Spurious precision: ten-decimal p-values or percentages to two decimals from a sample of 40.
- One-tailed tests used without justification, or sidedness never stated at all.
- Confidence intervals reported for some results but omitted exactly where the estimate is least favorable.

## Canonical links

- SAMPL entry (EQUATOR, with PDF): https://www.equator-network.org/reporting-guidelines/sampl/
- EQUATOR Network guideline library: https://www.equator-network.org/reporting-guidelines/
- Related: ASA statement on p-values: https://www.stat.berkeley.edu/~aldous/Real_World/ASA_statement.pdf
