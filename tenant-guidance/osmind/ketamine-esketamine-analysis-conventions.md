# Ketamine vs. esketamine RWE — shared analysis conventions

> ⚑ **Osmind-specific analysis convention.** Applies to any RWD study comparing
> IV racemic ketamine with IN esketamine in the Osmind warehouse (askp2026,
> ketamine-eske-gamm, and — as separate arms — mmb, nrx-rwe-protocol). Each
> project still locks its own controlled vocabulary (exact arm labels, study
> window, thresholds) as a PI decision; the shared starting point and rationale
> live here. Pair with [`rwd-column-catalog.md`](rwd-column-catalog.md).

**Arms and cohort assignment.** Two arms — `Ketamine` (IV racemic) and `Esketamine` (IN /
Spravato); use these exact strings. **Index the administration record, not the order:** define
first-exposure / index dates from `procedure_occurrence` only (`drug_exposure` has looser dating
— valid for ever-exposed exclusion sets but not index dates). Assign to the index-treatment arm;
censor at switch to the other drug within the outcome window for a head-to-head comparison.

**Windows and outcome.** Primary outcome **PHQ-9** (the only PRO with broad capture across both
interventional and non-interventional patients; MADRS is sparse and IN-esketamine-concentrated →
differential missingness). Baseline = closest pre-index PHQ-9 in **[−30, 0] days**; follow-up =
a **90-day** window. Responder definitions (ASCP-style): remission = PHQ-9 ≤ 4 at any
post-baseline assessment; response = ≥ 50% reduction from baseline at any assessment. Study
window is project-specific (all start 2021-01-01; end tracks the data snapshot). Single-diagnosis
category precedence when one is needed: **BP > PTSD > MDD > Other**.

**Effective-dose harmonization (IV ketamine ↔ IN esketamine).** Racemic ketamine is a 50:50
S/R mixture; esketamine is the S-enantiomer alone; the routes differ in bioavailability. Convert
each per-session dose to an effective mg/kg on a common enantiomer basis:

```
effective_mg_per_kg = total_mg × BA × (S_frac + ρ · R_frac) / weight_kg
```

| Drug | BA | S_frac | R_frac |
|---|---|---|---|
| IV racemic ketamine | 1.0 | 0.5 | 0.5 |
| IN esketamine | 0.5 | 1.0 | 0.0 |

`ρ` is the R-enantiomer potency weight relative to S. **Primary run: ρ = 0** (S-equivalent
basis); **ρ = 1** is a sensitivity analysis. **Avoid double-normalization:** the catalog's
`ketamine_dose_clean` is already mg/kg (that *is* the `total_mg/weight_kg` term — do not divide
again); for esketamine start from total per-session mg (`spravato_dose`, 56 or 84) and divide by
`weight_kg`. Keep BA, ρ, standard esketamine doses, the study window, and the code families in a
single config object so a parameter change never requires editing SQL. Weight-coverage caveat:
Spravato notes capture `patient_weight` for only ~52% of patients (vs ~84% for IV ketamine) —
consider a weight-observed sensitivity analysis. When the BA/enantiomer assumptions enter
externally-facing prose, back them with pharmacology references and state ρ/BA as explicit
modeling choices with a sensitivity analysis.
