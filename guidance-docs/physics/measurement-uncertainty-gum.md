# Expressing Measurement Uncertainty — GUM (JCGM 100:2008) and NIST TN 1297

> **Kuhn knowledge card.** Canonical source: https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf (JCGM / BIPM). Source access/license: freely downloadable; JCGM copyright with free reproduction for reference use. Companion NIST TN 1297 is public domain. This card is a Kuhn-authored summary — cite and consult the canonical sources for authoritative text.

## Scope

The Guide to the Expression of Uncertainty in Measurement (GUM, JCGM 100:2008) is the
international standard for evaluating and stating how well a measured value is known.
NIST Technical Note 1297 (Taylor & Kuyatt, 1994) is its concise, widely followed
implementation for NIST practice. The framework applies to any quantitative experimental
result — physics, chemistry, engineering, metrology — wherever a paper reports a measured
value, a fitted parameter, or a comparison against theory or another experiment. Journals
and standards bodies expect uncertainty statements in this vocabulary.

## Key requirements

**Model first**

- Express the measurand as a function of input quantities, Y = f(X₁, …, Xₙ).
- Every uncertainty statement flows from this measurement equation; unlisted influence
  quantities are the usual source of underestimated uncertainty.

**Two evaluation types — a classification of method, not of nature**

- **Type A**: evaluated by statistical analysis of repeated observations — e.g., the
  experimental standard deviation of the mean, s/√n, with its degrees of freedom.
  Report n and how the repeats were obtained.
- **Type B**: evaluated by other means — calibration certificates, manufacturer
  specifications, reference data, physical limits, prior experience — converted to a
  standard deviation via an assumed distribution: a ±a rectangular bound gives
  u = a/√3; a certificate quoting 95 % coverage gives u = U/1.96 for near-normal cases.
- Type B is not guessing and not inferior to Type A; it must be documented with its
  basis and assumed distribution.

**Combine, then expand**

- Express each input's uncertainty as a **standard uncertainty** u(xᵢ) — one standard
  deviation.
- The **combined standard uncertainty** u_c(y) follows from the law of propagation of
  uncertainty: quadrature sum of sensitivity-weighted terms (∂f/∂xᵢ)·u(xᵢ), plus
  covariance terms when inputs are correlated. Correlations (shared calibrations, common
  references) cannot be ignored because they are inconvenient.
- The **expanded uncertainty** U = k·u_c(y) defines an interval y ± U believed to
  contain the measurand at a stated level of confidence. Always report the **coverage
  factor** k; k = 2 (≈95 % for near-normal distributions) is the metrology default.
- With few effective degrees of freedom, use the Welch–Satterthwaite formula and a
  t-distribution value for k.

**Stating the result (GUM / TN 1297 forms)**

- Give the value, the uncertainty, the coverage factor or level, and what the
  uncertainty includes: "R = 0.523 46 Ω with U = 0.000 26 Ω (k = 2)".
- Concise parenthetical notation is standard for standard uncertainty:
  "m = 100.021 47(35) g", where the parentheses give u_c in units of the last digits.
- Round uncertainty to two significant figures and the value to the same final decimal
  place; never quote more digits than the uncertainty supports.
- Provide an **uncertainty budget** — a table of components (source, type, distribution,
  uᵢ, sensitivity coefficient, contribution) — in the paper or supplement for primary
  results.
- Uncertainty is not error. **Error** is the (unknowable) deviation from the true value;
  **uncertainty** characterizes the dispersion attributable to the measurand. Correct
  known systematic effects; the residual doubt about a correction enters as a Type B
  component — never fold an uncorrected known bias into the quoted uncertainty.

## How to apply when writing

- In Methods: state the measurement model, list the dominant uncertainty components,
  classify each as Type A or B with its evaluation basis, and note how correlations were
  handled.
- In Results: attach uncertainty to every headline number in one consistent notation;
  define it once ("uncertainties are standard uncertainties" or "expanded, k = 2") and
  never switch conventions silently.
- Use the vocabulary precisely: standard uncertainty u, combined standard uncertainty
  u_c, expanded uncertainty U, coverage factor k. Avoid bare "error bars show
  uncertainty" — say which kind (1σ standard? 95 % expanded?) and whether statistical
  only or combined.
- For fitted parameters, report how uncertainties were derived (covariance matrix,
  profile likelihood, bootstrap) and whether systematic components were added;
  particle-physics style "value ± stat ± syst" is acceptable when each part is defined.
- Compare with theory or prior measurements using combined uncertainties (normalized
  error or degrees of equivalence for metrology-grade claims).
- Keep the uncertainty-budget spreadsheet under version control with the analysis code;
  reviewers increasingly ask for it.

## Common pitfalls

- Quoting "±" with no statement of what it means — 1σ vs k = 2 vs a confidence interval
  changes the claim by a factor of two.
- Treating Type B components as optional, so the quoted uncertainty is repeatability
  only and the result later disagrees with other measurements.
- Ignoring correlations between inputs in the propagation, under- or overstating u_c.
- Reporting uncertainty to four significant figures, or a value with more decimals than
  its uncertainty.
- Conflating error with uncertainty, or "covering" a known uncorrected bias by inflating
  the error bar instead of applying the correction.
- Assuming √n averaging shrinks everything: it reduces only the random (Type A) part,
  never systematic components.

## Canonical links

- https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf — GUM, JCGM 100:2008 (full text)
- https://www.nist.gov/pml/nist-tn-1297-measurement-uncertainty-1-introduction — NIST TN 1297 guidelines
- https://www.bipm.org/en/committees/jc/jcgm/publications — JCGM publications (GUM supplements, VIM vocabulary)
