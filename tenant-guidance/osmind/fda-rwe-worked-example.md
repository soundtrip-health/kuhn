# FDA RWE — Osmind worked example (what landed with FDA)

> ⚑ **Osmind/client-specific.** The general FDA regulatory practice — the three
> pillars, the core guidance documents, and the briefing-book genre conventions —
> is generic and lives in the shared corpus at
> [`guidance-docs/rwe-protocol/fda-rwe-frameworks.md`](../../guidance-docs/rwe-protocol/fda-rwe-frameworks.md).
> This file holds the *worked example*: a NeuroRx Type C briefing built on Osmind
> EHR data, and references to the Osmind interventional-psychiatry network. It
> illustrates how the general lessons landed with FDA. **Company names in the
> worked example are confidential.**

## Regulatory precedent worth knowing

RWE has been accepted as *confirmatory* (not primary) evidence in psychiatry —
conditioned on a fit-for-purpose primary endpoint, a prespecified
indication-restricted cohort, and a protocol+SAP submitted before analysis. A
510(k) device label expansion via prespecified retrospective RWE is the closest
publicly available precedent for FDA accepting RWE-based decision-making in
psychiatry.

## Strengthening a retrospective base with a prospective registry

A retrospective EHR analysis is available *now* but carries structural weaknesses
(missingness on the driving variables, point-of-care assessment timing, indication
adjudicated only from codes). A purpose-built prospective registry run in parallel
resolves these *at the point of capture* at materially lower cost than a second
trial. Reusable design moves:

- **In-program instrument crosswalk** — collect the FDA-gold-standard instrument
  by independent raters in a defined calibration subset alongside the
  routinely-captured instrument, converting reliance on *published* concordance
  into an *in-program* crosswalk.
- **Mirror the pivotal protocol** — endpoints, windows, key data elements.
- **Prospective indication adjudication** at enrollment.
- **Controlled missingness + protocol-defined timing.**

Pair the two as one model: retrospective = external validity now; prospective
registry = fit-for-purpose-by-construction.

## Transferable RWE lessons (what landed with FDA)

1. **Confirmatory, not primary.** FDA accepted EHR-derived RWE as *confirmatory*
   alongside controlled trials — "in light of the structured nature of the medical
   record, its implementation of scales deemed fit-for-purpose by FDA, and its
   tracking of those scales pre- and post-treatment." Position RWE as confirmatory;
   never as pivotal evidence.
2. **Fit-for-purpose endpoint is the decisive lever.** The primary endpoint rested
   on a scale FDA already accepts; the questionable instrument was demoted to
   secondary and reframed as something the RWE would help *validate* by correlation.
3. **Prespecification + SAP submitted before any analysis** — FDA repeatedly
   conditioned acceptance on receiving a protocol and SAP "to review prior to data
   analysis," with the data "gathered and analyzed for the first time."
4. **Restrict the cohort to the target indication — prespecified.** FDA's lead
   deficiency was that the EHR population is "likely much broader than the target
   patient population"; the fix was a prespecified diagnostic-cohort restriction.
5. **"Purpose of prescription" inference can have FDA buy-in** — a
   primary-indication attribution argument from drug × specialty ×
   coincident-diagnosis has precedent of landing.
6. **Outcome ascertainment via the structured template** — lean on the structured
   EHR requirement that the physician records the scale pre- and post-treatment;
   pair with prespecified windows + sensitivity analyses for timing irregularity.
7. **Safety must be actively monitored, not self-reported** — present a Safety
   Analysis Set built on structured, actively-captured AE fields, and quantify them.

These lessons are why the Osmind warehouse's structured note templates, scale
capture, and interventional-psychiatry network matter to the regulatory argument:
the data model is what makes the fit-for-purpose and active-safety-monitoring
claims defensible.
