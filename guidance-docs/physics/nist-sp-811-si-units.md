# NIST SP 811 — Guide for the Use of the International System of Units (SI)

> **Kuhn knowledge card.** Canonical source: https://www.nist.gov/pml/special-publication-811 (National Institute of Standards and Technology). Source access/license: public domain (U.S. Government work); freely downloadable (2008 edition, Thompson & Taylor, DOI 10.6028/NIST.SP.811e2008). This card is a Kuhn-authored summary — the source is public domain, so examples here follow it closely; consult the canonical text for the full rule set.

## Scope

The authoritative U.S. style guide for writing SI quantities and units in scientific and
technical documents: unit symbols vs names, prefixes, spacing, mathematical operations on
units, and numeral formatting. Applies to every quantitative sentence, table, axis label,
and equation in physics, chemistry, and engineering manuscripts; consistent with BIPM's
SI Brochure and ISO/IEC 80000. Editors and reviewers treat these rules as non-negotiable
mechanics.

## Key requirements

**Symbols vs names**

- Unit symbols are standardized, case-sensitive, and international: m, kg, s, A, K, mol,
  cd; derived Hz, N, Pa, J, W, V, Ω. They are symbols, not abbreviations — never "sec",
  "cc", "amps", "mps".
- Symbols are upright (roman) type regardless of surrounding font, take no period
  (except at sentence end), and are identical in the plural: 75 cm, never 75 cms.
- Units named after people: symbol capitalized (Pa, W, K), spelled-out name lowercase
  ("pascal", "watt", "kelvin"); exception "degree Celsius" (°C).
- Liter may be L or l; L is preferred to avoid confusion with the numeral 1.
- Never mix names and symbols in one expression: "kilometers per hour" or km/h — not
  "kilometers/hour" or "km per hour".

**Value–unit spacing**

- Always a space between numerical value and unit symbol: 5 kg, 37 °C, 632.8 nm — and
  25 % (SP 811 treats % as a unit symbol requiring a space).
- No-space exceptions: plane-angle degree, minute, second of arc (30°, 22°30′).
- Value and unit form one entity: do not break them across lines.
- In ranges and lists, repeat the unit or bracket unambiguously: "from 20 °C to 30 °C"
  or "(20 to 30) °C"; dimensions as "1 mm × 5 mm", not "1 × 5 mm".
- Units attach to numerals, not to spelled-out numbers, and are not used as bare nouns:
  "the length is 10 m", not "ten m" or "several m long".

**Prefixes**

- One prefix per unit, attached with no space or hyphen: nm, GHz, kPa, μs. No compound
  prefixes (pF, not μμF).
- Case is meaning: k = kilo (10³) vs K = kelvin; m = milli vs M = mega.
- A prefixed unit raised to a power includes the prefix in the power:
  1 cm³ = (10⁻² m)³ = 10⁻⁶ m³.
- Mass peculiarity: prefixes attach to gram (mg, g, kg), never to kg (no "μkg").

**Multiplication, division, and "per"**

- Unit products take a half-high dot or a space: N·m or N m (arranged so "m" cannot read
  as a milli- prefix).
- Division uses a solidus or negative exponents: m/s, m·s⁻¹, W·m⁻²·K⁻¹.
- At most one solidus per expression unless parentheses remove ambiguity: m/s²,
  J/(mol·K) — never J/mol/K.
- The word "per" belongs with unit names ("meters per second"); the solidus with symbols.

**Numerals and quantity typography**

- Quantity symbols are italic (*m*, *T*, *E*); unit symbols upright — so *m* = 3 kg is
  unambiguous. Descriptive subscripts are upright; subscripts that are themselves
  quantities or running indices are italic.
- Decimal marker: point (U.S. practice). Digits may be grouped in threes with thin
  spaces, not commas, in international style: 1 234 567. Always a leading zero: 0.25,
  never .25.
- State quantities as value × unit algebra: "*v* = 3.5 m/s". A quantity divided by its
  unit is a pure number — the proper form for table headings and axis labels:
  *v*/(m/s), or "Velocity (m/s)" by common editorial concession.
- Do not attach extra information to units: "a mass fraction of 0.05" or "5 % by mass",
  not "5 wt%"; "AC voltage of 220 V", not "220 VAC".

## How to apply when writing

- Add a units pass to the editing checklist: scan every number for the value–unit space,
  symbol case, and prefix correctness. SP 811's own editorial checklist (its final
  section) is short enough to apply wholesale.
- Label table columns and plot axes as quantity with unit — "Pressure, *p* (kPa)" — and
  keep one unit per column; scale by prefix rather than appending ×10ⁿ factors where
  possible.
- Convert non-SI values at drafting time; where a non-SI unit is field-standard (eV,
  bar, Å), follow the journal's accepted-units list and give SI equivalents at first use.
- Use SP 811's conversion-factor appendix (public domain) for exact factors; avoid
  re-deriving or double-rounding conversions.
- In LaTeX, configure a units package (e.g., siunitx) once so spacing, upright units,
  and digit grouping come out mechanically right.

## Common pitfalls

- "10kg", "10 Kg", "10 kgs" — missing space, wrong case, or pluralized symbol.
- "sec", "hrs", "cc", "mps" — invented abbreviations in place of s, h, cm³, m/s.
- J/mol/K without parentheses; "°K" or "Kelvin degrees" — kelvin takes no degree sign.
- Mixed name–symbol hybrids ("km per hour") or unit symbols italicized by inheriting an
  italic context.
- Ambiguous ranges (10-15 mA) and dimension shorthand (2 × 2 cm intended as
  2 cm × 2 cm).
- Prefix case confusion: mK, MK, and mk differ by nine orders of magnitude or are
  meaningless.

## Canonical links

- https://www.nist.gov/pml/special-publication-811 — NIST SP 811 landing page (full guide)
- https://doi.org/10.6028/NIST.SP.811e2008 — SP 811 (2008 edition) DOI
- https://www.bipm.org/en/publications/si-brochure — BIPM SI Brochure (international SI definition)
- https://physics.nist.gov/cuu/Units/ — NIST reference on constants, units, and uncertainty
