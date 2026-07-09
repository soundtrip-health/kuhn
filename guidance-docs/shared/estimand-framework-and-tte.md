# ICH E9(R1) estimand framework & Target Trial Emulation

Cross-cutting statistical/methodological reference. Pairs with
`shared/stats-principles-estimands-sensitivity.pdf`.

## ICH E9(R1) estimand framework

A structured framework for defining treatment effects precisely in clinical/
real-world studies. **Source:** ICH E9(R1), *Addendum on Estimands and Sensitivity
Analysis in Clinical Trials* (adopted 2019). Regulatory bodies (FDA, EMA, PMDA)
expect confirmatory trial protocols to define estimands this way.

**The five attributes** (omit any one and the treatment effect is ambiguous):

1. **Treatment(s)** — which interventions are compared (regimen, timing, dose).
2. **Population** — which patients the effect pertains to (eligibility + any further
   specification).
3. **Endpoint** — what variable, at what time, derived how (change from baseline,
   time-to-event, responder definition).
4. **Intercurrent event strategy** — how post-initiation events affecting
   interpretation are handled. Five canonical strategies: **treatment policy**
   (include data regardless); **composite** (fold the event into the endpoint);
   **hypothetical** (estimate what would have happened without it);
   **while-on-treatment** (restrict to data before the event); **principal stratum**
   (effect within a subpopulation defined by event status).
5. **Population-level summary** — difference in means? hazard ratio? odds ratio? risk
   difference?

**Using it.** Name the estimand (e.g., "primary estimand"); describe it in prose
before equations (a paragraph naming all five attributes); report each estimand
separately; use sensitivity analyses to test specific assumptions of the primary
estimand (e.g., MAR for missing data; constancy in NI designs).

**Common pitfalls.** Confusing estimands (*what* — a population quantity) with
estimators (*how* — the procedure). Treating missing data as purely technical — it
almost always signals an intercurrent event. "Per-protocol" is an analysis
population, not an estimand. Non-inferiority designs imply the constancy assumption
(the active control's effect in the reference trial transfers to the current setting)
— address it explicitly.

**Application to observational / RWE studies.** The framework is widely applied
beyond RCTs: target-trial emulation maps cleanly onto estimands (define the "target
trial" estimand first, then describe how the observational study estimates it);
intercurrent events in RWE (treatment switching, protocol deviations, loss to
follow-up, informative censoring) need explicit strategies; propensity-score analyses
must specify the estimand (ATE, ATT, ATC) and the weighting/matching method together.

**When a project needs it:** randomized trial protocols — always; observational
studies aiming for causal inference — always; RWE submissions to FDA/EMA — always;
descriptive lit reviews or narrative reports — generally not (cite E9(R1) only where
you draw a causal conclusion).

## Target Trial Emulation (TTE)

Design an observational / RWD study by specifying the randomized trial it emulates,
then describing how the data approximate each element — this forces the decisions that
otherwise produce immortal-time bias, prevalent-user bias, ill-defined "time zero,"
and confounding by indication, and gives a reviewer a clean structure to audit.
(Canonical reference: the Hernán & Robins target-trial framework — RA to source the
citation before it enters prose.)

Specify each target-trial element, then its emulation:

- **Eligibility** — assessed with pre-baseline info only (using post-baseline info
  causes selection bias).
- **Treatment strategies** — operationally defined.
- **Assignment / "time zero"** — eligibility, assignment, and follow-up start must
  coincide (misalignment causes immortal-time bias).
- **Outcome** — endpoint, instrument, timing — ascertained the same way across arms.
- **Follow-up window.**
- **Causal contrast (estimand)** — mapped to ICH E9(R1) above: define the target
  trial's estimand first, then how the study estimates it; give each intercurrent
  event a strategy; state the estimand (ATE/ATT/ATC) with the PS weighting/matching
  method.
- **Analysis** — confounding control, sensitivity analyses.

The usual default is a **new-user, active-comparator** design (initiators of one
strategy vs. a comparable alternative, clean time zero at initiation). When no
credible counterfactual exists (e.g. no placebo arm can be emulated in
actively-treated patients), an **open-label single-arm pre/post emulation** of a
published single-arm trial is legitimate — the estimand becomes a population-level
post-initiation trajectory, and you state plainly that no counterfactual is emulated.
