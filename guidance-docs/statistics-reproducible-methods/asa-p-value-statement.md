# ASA Statement on Statistical Significance and P-Values

> **Kuhn knowledge card.** Canonical source: https://www.stat.berkeley.edu/~aldous/Real_World/ASA_statement.pdf (American Statistical Association; Wasserstein & Lazar, *The American Statistician* 2016). Source access/license: freely accessible PDF; the article text is ASA/Taylor & Francis-copyrighted — this card paraphrases the six principles rather than quoting them. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

The 2016 ASA Statement is the professional statistical community's formal position on how p-values should — and should not — be interpreted and reported. It was prompted by the reproducibility crisis and widespread misuse of "p < 0.05" as a publication gatekeeper.

It applies to any manuscript that reports null-hypothesis significance tests: experimental and observational studies alike, across all disciplines. A 2019 follow-up editorial in *The American Statistician* ("Moving to a world beyond p < 0.05") extends the message, urging that the label "statistically significant" be retired as a bright-line verdict. The statement governs *interpretation and wording*, not choice of statistical method.

## Key requirements

The statement's six principles, paraphrased:

1. **What a p-value is.** It indicates how incompatible the observed data are with a specified statistical model (usually the null hypothesis plus all its accompanying assumptions). Small p means the data are unusual *if* the whole model holds.
2. **What it is not.** A p-value is not the probability that the null hypothesis is true, nor the probability that the results arose by chance alone. Writing "there is only a 3% chance this result is due to chance" misstates what was computed.
3. **No bright-line decisions.** Scientific conclusions and practical decisions should not hinge solely on whether p crosses an arbitrary threshold such as 0.05. Evidence is continuous; p of 0.049 and 0.051 are essentially the same strength of evidence.
4. **Full transparency.** Sound inference requires complete reporting: how many analyses were run, which were planned, and how variables and models were selected. Selective reporting of the tests that "worked" (p-hacking, the garden of forking paths) invalidates the nominal p-values.
5. **P is not effect size.** A p-value measures neither the magnitude nor the practical importance of an effect. With huge samples, trivial effects reach tiny p-values; with small samples, large effects can miss thresholds.
6. **P alone is weak evidence.** By itself a p-value provides limited information about the model or hypothesis; context, prior evidence, design quality, and complementary measures matter.

**Recommended complements.** The statement points toward estimation and richer inference rather than verdicts:

- Effect sizes with confidence (or credible) intervals as the primary quantitative summary.
- Bayesian methods, likelihood ratios, and false-discovery-rate approaches where appropriate.
- Decision-theoretic framing when results drive decisions.
- Above all, good design and complete disclosure — no statistical fix rescues a selectively reported analysis.

## How to apply when writing

- **Results:** report exact p-values (p = 0.03, not p < 0.05; use p < 0.001 only below that), always alongside the point estimate, its effect size, and a confidence interval. Lead sentences with the estimate ("the intervention reduced scores by 4.2 points, 95% CI [1.1, 7.3]"), letting p support rather than headline.
- **Avoid verdict language.** Prefer descriptions of estimate and uncertainty over "significant/non-significant" dichotomies; if the term is used at all, reserve "significant" for its statistical meaning and never let it imply practical importance.
- **Never accept the null.** p > 0.05 is "no evidence of a difference," not "evidence of no difference." Claims of equivalence need equivalence testing (e.g., TOST) or interval-based reasoning, not a failed significance test.
- **Disclose multiplicity.** State how many outcomes, subgroups, and model specifications were examined; label unplanned analyses exploratory; report all conducted tests, not just favorable ones.
- **Discussion:** interpret findings by magnitude, precision, and consistency with prior evidence. Do not treat one small-p study as definitive, and do not describe p = 0.06 as "trending toward significance."
- **Methods:** if thresholds are used (e.g., for screening in a pipeline), justify them and state alpha, sidedness, and any multiplicity corrections a priori.

**Wording guide** — preferred phrasings versus wording the statement warns against:

- Say "the data are inconsistent with the null model (p = 0.004)" — not "the null hypothesis has only a 0.4% chance of being true."
- Say "we found no evidence of a difference (difference 0.4, 95% CI [-1.2, 2.0])" — not "there was no difference between groups."
- Say "the effect was small but precisely estimated" — not "the effect was highly significant."
- Say "this exploratory comparison, uncorrected for multiplicity, showed…" — not an unqualified "significant" for one of many looks.

## Common pitfalls

- Interpreting p as the probability the hypothesis is true or the result is "due to chance."
- Dichotomizing results at 0.05 and building the narrative around which side of the line each test fell.
- Reporting p-values without effect sizes or intervals, or reporting "NS" without the actual value.
- Treating non-significance as proof of no effect, especially in underpowered comparisons.
- "Trend toward significance" and similar hedges for p slightly above threshold.
- Undisclosed multiple testing — many looks, one reported p — which makes the nominal p-value meaningless.
- Assuming a replication with p just above 0.05 "contradicts" an original with p just below it — compare the estimates and intervals, not the verdicts.
- Letting "significance" language migrate from Results into Abstract and Discussion as claims of importance or proof.

## Canonical links

- ASA Statement PDF: https://www.stat.berkeley.edu/~aldous/Real_World/ASA_statement.pdf
- Publisher record (The American Statistician, 2016): https://www.tandfonline.com/doi/full/10.1080/00031305.2016.1154108
- 2019 follow-up editorial, "Moving to a World Beyond p < 0.05": https://www.tandfonline.com/doi/full/10.1080/00031305.2019.1583913
