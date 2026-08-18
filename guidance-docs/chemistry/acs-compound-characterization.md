# Compound Characterization and Spectroscopic Data Reporting (ACS Norms)

> **Kuhn knowledge card.** Canonical source: https://pubsapp.acs.org/paragonplus/submission/acs_nmr_guidelines.pdf (American Chemical Society). Source access/license: freely downloadable PDF; ACS-copyrighted text, paraphrased here. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

Characterization-data conventions expected by ACS journals (JACS, J. Org. Chem.,
Org. Lett., J. Med. Chem., etc.) and broadly mirrored across synthetic-chemistry
publishing. Applies to the Experimental Section and Supporting Information of any paper
reporting new compounds: NMR data blocks, high-resolution mass spectrometry (HRMS),
purity evidence, and the general identity/purity dossier each new compound must carry.
Journal-specific author guidelines override; these are the shared norms.

## Key requirements

**What every new compound needs**

- Proof of identity: ¹H NMR and ¹³C NMR data (with spectra images in the SI), plus HRMS
  or elemental analysis; melting point for solids; optical rotation for enantioenriched
  compounds; IR where diagnostic.
- Known compounds need a literature citation plus data sufficient to confirm identity.
- Proof of purity: elemental analysis within ±0.4% of calculated values, **or** clean
  ¹H/¹³C spectra plus a quantitative method. Medicinal-chemistry journals require ≥95%
  purity for tested compounds, established by HPLC (with method details), qNMR, or
  similar — with the actual percentage stated when below 95%. Spectra alone are not a
  purity claim.

**¹H NMR data block (paraphrased ACS format)**

- Header states nucleus, field strength, solvent: "¹H NMR (500 MHz, CDCl₃)".
- Chemical shifts (δ, ppm) referenced to residual solvent or TMS (stated once in General
  Methods), to two decimal places, listed in a consistent direction (typically downfield
  to upfield).
- Each signal carries: δ value (or range for multiplets), multiplicity abbreviation
  (s, d, t, q, m, dd, br s, …), coupling constants *J* in Hz to one decimal with the
  largest first (*J* = 8.2, 2.1 Hz), and integration as nH.
- Example form: δ 7.42 (d, *J* = 8.2 Hz, 2H).
- Multiplicities describe the observed pattern; use "m" with a range when the pattern is
  not first-order. Report all observed exchangeable protons.

**¹³C NMR data block**

- Header gives the actual ¹³C frequency, not the ¹H field: "¹³C NMR (126 MHz, CDCl₃)"
  on a 500 MHz instrument.
- Shifts to one decimal place; list every distinct carbon and note coincidental
  overlaps; report C–F or C–P coupling constants where resolved.
- Indicate proton decoupling ({¹H}) per journal convention. DEPT/HSQC-supported
  assignments (CH₃, CH₂, CH, C) are encouraged but must be labeled as assignments.

**HRMS**

- Report ionization method and analyzer, the ion assignment, and calculated vs found:
  "HRMS (ESI-TOF) m/z: [M + Na]⁺ calcd for C₁₂H₁₅NO₃Na 244.0944; found 244.0946".
- Agreement within roughly 5 ppm (often <3 mDa) of the exact mass is the accepted
  identity criterion. HRMS confirms molecular formula, never purity.

**Other data conventions**

- Optical rotation: [α]ᴅ with temperature superscript, concentration *c* in g/100 mL,
  and solvent — e.g., [α]²⁵ᴅ = −34.2 (*c* 1.0, CHCl₃).
- Melting points labeled "uncorrected" if so; Rf values with the solvent system; IR with
  key bands in cm⁻¹.
- SI contains reproductions of ¹H/¹³C spectra for all new compounds, numbered to match
  the manuscript; raw FID deposition is increasingly encouraged (NMReDATA / nmrML
  formats where supported).

## How to apply when writing

- Set a General Methods paragraph once — instruments and field strengths, solvents and
  referencing, chromatography materials, HRMS instrument, purity method — then never
  repeat those details per compound.
- Write each compound entry in a fixed order: procedure; yield (mass, mmol, %); physical
  state and mp; Rf / [α]; ¹H NMR; ¹³C NMR; IR; HRMS; purity — identical ordering for
  every compound.
- Extract *J* values from the spectrum, not from expectation; verify reciprocal
  couplings match across coupled partners.
- Cross-check the HRMS calculated mass against the drawn structure's formula (including
  the adduct ion) before submission.
- Number compounds boldface in text (**3a**) and keep manuscript, scheme, and SI
  numbering in lockstep through revisions.
- For enantioenriched products, report ee/er with the chiral method (column, eluent,
  retention times of both enantiomers) alongside the optical rotation.

## Common pitfalls

- ¹³C field strength reported as the ¹H frequency ("¹³C NMR (500 MHz…)" — it should be
  126 MHz on a 500 MHz spectrometer).
- Coupling constants that do not match between coupled partners, or *J* values quoted
  for signals labeled "m".
- Using low-resolution MS — or HRMS — as a purity claim, or omitting the adduct in the
  ion assignment.
- Inconsistent referencing (TMS vs residual solvent) across compounds, or swapping the
  decimal conventions (¹H takes two decimals, ¹³C one).
- Missing purity evidence for biologically tested compounds — ≥95% by a stated
  quantitative method is the norm in J. Med. Chem.-type journals.
- SI spectra without compound numbers, or numbering that drifts from the manuscript
  after revision.

## Canonical links

- https://pubsapp.acs.org/paragonplus/submission/acs_nmr_guidelines.pdf — ACS NMR data reporting guidelines (PDF)
- https://pubs.acs.org/page/4authors/submission_guide — ACS journal manuscript submission guide
- https://pubs.acs.org/doi/10.1021/jm801525s — J. Med. Chem. compound purity requirements
- https://nmredatainitiative.github.io/ — NMReDATA standard for machine-readable NMR assignments
