# FDA Bioanalytical Method Validation / ICH M10

> **Kuhn knowledge card.** Canonical source: https://www.fda.gov/files/drugs/published/Bioanalytical-Method-Validation-Guidance-for-Industry.pdf (FDA, Guidance for Industry, 2018). Source access/license: free; FDA guidance is a U.S. government work in the public domain. The harmonized successor, ICH M10 (2022), is freely available from the ICH database. This card is a Kuhn-authored summary — cite and consult the canonical sources for authoritative text.

## Scope

These guidances define how to **validate bioanalytical methods** — chiefly chromatographic assays (LC-MS/MS, GC-MS) and ligand-binding assays (ELISA and related immunoassays) — that quantify drugs, metabolites, and biotherapeutics in biological matrices (plasma, serum, blood, urine, tissue), and how to conduct and document **study sample analysis** using those methods. They apply to data submitted in INDs, NDAs, ANDAs, BLAs, and comparable global filings: pharmacokinetic, toxicokinetic, bioavailability/bioequivalence, and exposure-response studies. FDA adopted ICH M10 as the harmonized standard (2022), which supersedes region-specific guidance for new work; the concepts below are common to both. Biomarker and diagnostic assays follow related but distinct (context-of-use) expectations.

## Key requirements

Paraphrased validation parameters and acceptance concepts:

- **Selectivity/specificity.** The method must distinguish the analyte from matrix components, metabolites, concomitant drugs, and (for ligand-binding assays) interference from target ligands or anti-drug antibodies. Typically demonstrated in multiple independent matrix lots, including hemolyzed and lipemic samples.
- **Calibration curve and range.** A validated response function across the expected concentration range, defined by a lower limit of quantification (LLOQ) and upper limit (ULOQ), with a blank and zero standard plus at least six non-zero calibrators for chromatographic assays.
  - Back-calculated calibrator concentrations must fall within defined tolerance — conceptually ±15% of nominal (±20% at the LLOQ) for chromatography, and wider (±20%, ±25% at the curve limits) for ligand-binding assays.
- **Accuracy and precision.** Assessed with quality-control (QC) samples at multiple levels (LLOQ, low, mid, high) across several runs and days, both within-run and between-run. Acceptance is conceptually the same ±15%/±20%-at-LLOQ envelope for mean accuracy and precision (CV) in chromatographic assays, relaxed for ligand-binding assays.
- **Sensitivity.** The LLOQ must be justified against study needs (e.g., ability to characterize the terminal phase of the PK profile) and meet accuracy/precision criteria.
- **Matrix effects and recovery** (chromatography). Evaluate ionization suppression/enhancement across matrix lots; recovery need not be 100% but must be consistent and reproducible.
- **Carryover.** Demonstrated not to affect quantification (blank after ULOQ injection).
- **Stability.** The analyte must be shown stable under every condition study samples actually experience:
  - bench-top / short-term stability at processing temperature;
  - freeze–thaw stability covering at least the number of cycles study samples undergo;
  - long-term frozen storage at the actual storage temperature, for at least as long as samples are stored before analysis;
  - processed-sample (autosampler/extract) stability;
  - stock- and working-solution stability.
- **Dilution integrity and parallelism.** Dilution of above-ULOQ samples must not bias results; ligand-binding assays additionally assess parallelism with incurred samples and minimum required dilution.
- **Run acceptance in study sample analysis.** Each analytical run needs calibrators and QCs interspersed with study samples; a run passes when the calibration curve and a defined fraction of QCs (conceptually two-thirds overall and at least half at each level) meet criteria.
  - Repeat-analysis and chromatogram-reintegration require pre-specified, documented rules; failed runs are reported with reasons, not silently discarded.
- **Incurred sample reanalysis (ISR).** A defined portion of real study samples (about 10% of the first 1,000, then ~5% beyond) must be reanalyzed.
  - Results must agree with the original within concept thresholds — two-thirds within ±20% for chromatography, ±30% for ligand-binding — a check that the method works on real samples, not just spiked QCs.
- **Partial and cross-validation.** Method changes (matrix, species, instrument, lab) trigger scaled partial validation; data pooled across labs/methods require cross-validation.
- **Documentation.** Validation reports and bioanalytical study reports must be sufficient to reconstruct the analysis, recording:
  - method description, reference standards, and critical reagents (with lot tracking for ligand-binding assays);
  - all runs — accepted *and* failed, with reasons — plus calibration and QC performance tables;
  - chromatograms for a defined subset of samples, deviations from the method or SOPs, and ISR results.

## How to apply when writing

- In a methods section or bioanalytical report, name the platform and the guideline followed ("validated per ICH M10 / FDA 2018 BMV"), then state: analyte(s) and internal standard, matrix and anticoagulant, extraction, calibration range (LLOQ–ULOQ), and the accuracy/precision achieved — with numbers, not just "the method was validated."
- Always report the LLOQ alongside PK results, and state how below-LLOQ values were handled in PK/statistical analysis (e.g., set to zero before Tmax, missing after).
- Report stability coverage explicitly: longest storage duration and temperature of study samples versus demonstrated long-term stability, and number of freeze–thaw cycles covered.
- Include the ISR outcome (n reanalyzed, % within agreement limits) in any regulated PK study report — reviewers look for it.
- For toxicokinetics in GLP studies, state the validation status of the method in the study matrix/species; a method validated in human plasma does not automatically cover rat plasma (partial validation needed).
- When pooling concentrations across studies, labs, or assay versions, describe the cross-validation that justifies pooling.

## Common pitfalls

- Writing "fit-for-purpose validated" without reporting range, LLOQ, accuracy/precision, or stability data.
- Stability claims that don't cover actual sample age or freeze–thaw history at analysis time.
- Silence on ISR, or on failed/repeated runs and the rules used for repeats and reintegration.
- Applying chromatographic acceptance numbers to ligand-binding assays (or vice versa) — the envelopes differ.
- Ignoring matrix effects/parallelism when quantifying biotherapeutics in the presence of target or anti-drug antibodies.
- Missing critical-reagent (e.g., capture/detection antibody lot) documentation across ligand-binding method versions.
- Treating a biomarker assay as if PK-style validation criteria automatically apply — biomarker methods are validated to their context of use.

## Canonical links

- FDA Bioanalytical Method Validation, Guidance for Industry (2018): https://www.fda.gov/files/drugs/published/Bioanalytical-Method-Validation-Guidance-for-Industry.pdf
- ICH M10: Bioanalytical Method Validation and Study Sample Analysis (Step 4, 2022): https://database.ich.org/sites/default/files/M10_Guideline_Step_4_2022_1114.pdf
- FDA guidance search portal (current adoption status): https://www.fda.gov/regulatory-information/search-fda-guidance-documents
