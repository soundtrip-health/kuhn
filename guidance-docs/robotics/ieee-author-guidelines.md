# IEEE Editorial Style and Robotics Manuscript Conventions

> **Kuhn knowledge card.** Canonical source: https://www.ieee.org/publications-standards/publications/authors/index.html (IEEE). Source access/license: guidelines and templates freely available via the IEEE Author Center; underlying style-manual text is IEEE-copyrighted. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

Manuscript preparation for IEEE journals and conferences, with emphasis on the robotics
venues: ICRA, IROS, RSS (RSS uses its own template but IEEE-adjacent conventions), IEEE
Transactions on Robotics (T-RO), Robotics and Automation Letters (RA-L), Robotics &
Automation Magazine (RAM), and Transactions on Field Robotics (T-FR). Applies to full
papers, letters, and conference submissions in the IEEE two-column format, prepared in
LaTeX (IEEEtran class) or Word from the official templates.

## Key requirements

**Structure and format**

- Two-column IEEE format from the official template; do not alter margins, fonts, or
  column widths — venues desk-reject papers that tamper with the template.
- Standard skeleton: Title; author block (anonymized where required); Abstract (one
  paragraph, ~150–250 words, no citations, no undefined acronyms); Index Terms; numbered
  sections (I. Introduction … Conclusion); Appendix; Acknowledgments; References.
- Section numbering uses Roman numerals with lettered subsections (II-A, II-B).
- Page-limit norms (verify the current call for papers — they shift year to year):
  - **ICRA**: 8 pages including all figures, tables, and references; strictly enforced.
  - **IROS**: 6 pages plus up to 2 extra pages (charges may apply), via PaperPlaza.
  - **RA-L**: 6 pages, expandable to 8 with fees; first decision targeted within 3 months.
  - **RSS**: template-specific limit with a mandatory "Limitations" section.
- ICRA/IROS/RA-L use double-anonymous review in recent cycles: remove author-identifying
  information and cite your own prior work in the third person.
- Recent IEEE and conference policies require disclosure of generative-AI use (typically
  in Acknowledgments) and prohibit listing AI tools as authors.

**Units, numbers, and abbreviations**

- SI units are required; imperial values may appear parenthetically.
- A space separates value and unit (10 kg, 3.5 m/s); unit symbols are upright, never italic.
- Define every acronym at first use in the body (and separately in the abstract if used
  there); use it consistently thereafter.
- Use numerals with units; spell out numbers that begin a sentence.

**Math and notation**

- Variables in italics (x, θ); vectors and matrices commonly bold; function names
  (sin, max), constants, and units upright. Notation must match across text, equations,
  algorithms, and figures.
- Number all displayed equations sequentially in parentheses, right-aligned: (1), (2).
- Cite equations as "(3)" or "Eq. (3)"; "Equation (3)" only at sentence start — never
  bare "equation 3".
- Punctuate displayed equations as part of the sentence; define every symbol at first use.

**References (IEEE numeric style)**

- Bracketed numerals in citation order: [1], [3]–[5]; used inline as grammatical markers
  ("as shown in [4]"), never author-year.
- Reference pattern: initials then surname ("J. K. Author"); paper title in quotes,
  sentence case; venue in italics with standard IEEE abbreviations (*IEEE Trans. Robot.*,
  *Proc. IEEE Int. Conf. Robot. Autom. (ICRA)*); volume, number, pages, month, year, DOI.
- References count toward the ICRA page limit — budget for them.

**Figures and tables**

- Figure captions below figures ("Fig. 1."); table captions above tables ("TABLE I",
  Roman numerals). Every figure and table must be cited in the text.
- Axis labels carry quantity and unit; fonts must stay legible at final column width
  (roughly body-text size in print).

## How to apply when writing

- Start from the current year's official template and author kit for the target venue;
  verify page limit and anonymization policy in that year's call, not last year's.
- Draft the abstract as a self-contained summary — problem, approach, key quantitative
  result; no citations, no "in this paper we will".
- Keep a symbol glossary while drafting so notation never diverges between text,
  equations, and figure annotations.
- Convert all measurements to SI at drafting time; report robot specifications (payload,
  reach, repeatability) with units and cite the platform.
- Run the venue's PDF compliance check (PaperPlaza / IEEE PDF eXpress) before submitting —
  noncompliant PDFs are rejected mechanically.
- For RSS, write the Limitations section as a genuine discussion of failure modes and
  scope boundaries; a perfunctory paragraph is a review liability.

## Common pitfalls

- Exceeding the ICRA 8-page all-inclusive limit because references and figures were not
  budgeted.
- Breaking anonymity via acknowledgments, dataset URLs, "our previous work [7]" phrasing,
  or PDF metadata.
- Italic units or unit-less axis labels in figures; captions on the wrong side (figure
  captions go below, table captions above).
- Citing equations as "equation 3" mid-sentence, or leaving equations unnumbered and
  unreferenced.
- Non-IEEE reference formatting (author-year citations, full journal names, missing DOIs)
  requiring wholesale rework at camera-ready.
- Shrinking template fonts or margins to fit content — grounds for summary rejection.

## Canonical links

- https://www.ieee.org/publications-standards/publications/authors/index.html — IEEE Author Center (templates, style resources)
- https://www.ieee-ras.org/publications/ra-l/ra-l-information-for-authors/ — RA-L information for authors
- https://2026.ieee-icra.org/contribute/final-paper-submission-instructions/ — ICRA final-paper submission instructions
- https://roboticsconference.org/2025/information/authorinfo/ — RSS author information
