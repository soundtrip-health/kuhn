# APS / Physical Review Style and Physics Notation Conventions

> **Kuhn knowledge card.** Canonical source: https://journals.aps.org/authors (American Physical Society). Source access/license: author guidance and the Physical Review Style and Notation Guide are freely accessible; APS-copyrighted text, paraphrased here. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

Manuscript style for the Physical Review family (PRL, PRA–PRE, PRX and PRX-branded
journals, PR Applied, Reviews of Modern Physics) and, by influence, most physics writing.
Covers article structure, mathematical typography and notation, reference format, figures,
and current APS policies (data availability). Manuscripts are normally prepared in
REVTeX 4.2; the conventions below apply regardless of tool.

## Key requirements

**Structure**

- Physical Review articles use: title; author list with affiliations; abstract (one
  self-contained paragraph, no numbered references); numbered sections
  (I. INTRODUCTION, II. …, with subsections II.A); acknowledgments; appendixes;
  references.
- PRL Letters are length-limited (roughly 3750 words equivalent, with figures counted by
  an area-based formula) and use minimal or no section headings.
- Since December 2024, all Physical Review submissions require a **data availability
  statement** chosen from APS's pre-scripted options, with justification when data are
  not publicly shared.
- SI units are standard (Gaussian units acceptable in some subfields if consistent and
  identified); symbols follow IUPAP/BIPM conventions.

**Math typography and notation (Style and Notation Guide, paraphrased)**

- Variables and physical-quantity symbols: italic (E, p, ψ). Vectors: boldface (**p**)
  rather than arrows. Matrix/tensor conventions per subfield, applied consistently.
- Upright (roman) type for: unit symbols (eV, T, K); standard function and operator
  names (sin, exp, ln, Tr, Re, Im); chemical symbols and particle labels; descriptive
  subscripts (E_kin has upright "kin", while an index subscript *i* stays italic).
- Number displayed equations sequentially, (1), (2) — and cite them as "Eq. (3)"
  mid-sentence, "Equation (3)" at sentence start. Equations are punctuated as parts of
  the sentence.
- Use built-up fractions in displayed math but slashed or negative-exponent forms
  inline; break long equations at operators and align multi-line derivations on
  relation signs.
- Quantum and particle conventions follow the field: bra-ket notation |ψ⟩, operator
  carets where ambiguity exists, ħ, and a metric signature / natural-unit convention
  declared once.

**References and citations**

- Numeric citations in square brackets in order of first appearance: [1], [4–6]; the
  reference list contains only cited works.
- Physical Review reference pattern: initials + surname (author cutoff then *et al.*);
  journal in standard abbreviation (Phys. Rev. Lett., Phys. Rev. D); **volume in bold**;
  first page or article number; year in parentheses. Historically PR omitted article
  titles; including titles is now accepted and encouraged.
- Cite arXiv identifiers for preprints (arXiv:2401.01234) and DOIs for datasets and
  software.
- Footnotes are folded into the numbered reference list in Physical Review, not placed
  at page bottoms.

**Figures and tables**

- Figures numbered "FIG. 1." with captions below; tables "TABLE I." with captions above.
- Refer to "Fig. 2" mid-sentence, "Figure 2" at sentence start.
- Axis labels give quantity and unit; color figures must survive grayscale print and be
  accessible to color-blind readers.
- Line art and lettering must remain legible reduced to single-column width (~8.6 cm),
  with consistent fonts across all figures.

## How to apply when writing

- Prepare in REVTeX 4.2 with the target-journal option (aps, prl, prd, …); use BibTeX
  with the APS style so volume bolding and journal abbreviations come out mechanically.
- Write the abstract as the paper in miniature — context, method, principal quantitative
  result — with no citations and no undefined jargon; PRL abstracts must convey
  significance to non-specialists.
- Declare notation early (metric signature, natural units such as ħ = c = 1, Fourier
  conventions) and never switch silently mid-paper.
- Report measured values with uncertainties in APS-standard forms — concise parenthetical
  notation 1.234 56(78), or explicit "± stat ± syst" with each part defined.
- Draft the data availability statement while writing Methods, not at submission; pick
  the pre-scripted APS statement that matches what is actually deposited.
- For PRL, check the length formula (words plus figure-size-dependent equivalents)
  before polishing; cutting late is expensive.

## Common pitfalls

- Vectors typeset with arrows or left unbolded, or conventions differing between text
  and figures.
- Units and standard functions in italics — the artifact of writing everything in math
  mode without \mathrm or \text.
- References with unabbreviated journal names, missing bold volumes, or author-year
  style left over from another field's template.
- Capitalization/abbreviation errors: "equation 3", "figure 2" (should be Eq. (3),
  Fig. 2 mid-sentence).
- Omitting the now-mandatory data availability statement, or letting it contradict the
  paper (statement says deposited; no identifier given).
- PRL submissions over the length formula because figures were counted as zero words.

## Canonical links

- https://journals.aps.org/authors — APS information for authors (portal)
- https://journals.aps.org/authors/style-basics — APS style basics guide
- https://cdn.journals.aps.org/files/styleguide-pr.pdf — Physical Review Style and Notation Guide (PDF)
- https://journals.aps.org/revtex — REVTeX 4.2 package and author's guide
