# Chemical Identifiers in Publications: InChI, InChIKey, SMILES, CAS

> **Kuhn knowledge card.** Canonical source: https://iupac.org/who-we-are/divisions/division-details/inchi/ (IUPAC). Source access/license: InChI is a free, open IUPAC standard with open-source software (InChI Trust); SMILES is a free de-facto standard; CAS Registry Numbers are assigned by CAS (a division of ACS) and free to cite. This card is a Kuhn-authored summary — cite and consult the canonical sources for authoritative text.

## Scope

When and how to report machine-readable compound identity in chemistry manuscripts,
supporting information, and datasets. Applies to synthesis papers (every new and key
known compound), medicinal-chemistry and SAR tables, analytical and environmental
studies (target and suspect lists), and any data deposition (PubChem, institutional
repositories, FAIR-compliant datasets). Covers the three identifier families writers
actually use — IUPAC InChI/InChIKey, SMILES, and CAS Registry Numbers — what each
encodes, where each belongs, and how to present it.

## Key requirements

**InChI (IUPAC International Chemical Identifier)**

- A non-proprietary, algorithmically generated, canonical string encoding structure in
  layers: molecular formula, connectivity, hydrogen positions, charge, stereochemistry,
  isotopes, and (in standard InChI) normalized tautomer handling.
- One structure yields one standard InChI — this canonicity makes it the interchange
  identifier of record across databases and publications.
- Standard InChI strings begin `InChI=1S/`. Generate them only with the official InChI
  software (InChI Trust releases) or tools embedding it — never by hand.
- **InChIKey** is the fixed-length, 27-character hashed form: a 14-character
  connectivity block, a hyphen, then blocks encoding stereo/isotopes/version and
  protonation. It exists for indexing and web search, not structure reconstruction
  (the hash is one-way). Two compounds sharing the first block share a skeleton but may
  differ in stereochemistry.

**SMILES**

- A compact ASCII line notation readable by essentially all cheminformatics software;
  supports stereochemistry (`@`, `/`, `\`) and isotopes.
- Unlike InChI it is **not canonical across software** — many valid SMILES exist for one
  molecule, and different toolkits canonicalize differently.
- Fine as a working/exchange format in SI tables and datasets; pair it with
  InChI/InChIKey when uniqueness matters.

**CAS Registry Numbers**

- Curated database accession numbers (format like 50-00-0), not structure-derived: they
  can distinguish salts, hydrates, and mixtures that structure identifiers merge, but
  cannot be computed from a structure and exist only for registered substances.
- Cite them for known compounds and purchased reagents; a genuinely new compound has
  none until registered.

**Where identifiers belong in a manuscript**

- Reagents and known compounds: name + CAS number (with supplier and purity in methods).
- New compounds: systematic name in the characterization block; InChI/InChIKey and
  SMILES in the SI, ideally as a machine-readable table (CSV or SDF) covering every
  numbered compound.
- Data depositions and SAR tables: a SMILES column plus an InChIKey column; deposit
  structures to PubChem or a repository where journal policy supports it.
- Identifiers must correspond to the exact species studied: correct salt form,
  stereochemistry, and isotopic labeling — the free base's identifier is wrong if the
  work used the hydrochloride.

## How to apply when writing

- Build one compound-identity table early (compound number, name, SMILES, InChI,
  InChIKey, CAS if any); keep it synchronized with manuscript numbering and export it
  into the SI verbatim.
- Generate InChI/InChIKey with current official software and record the software version
  in the SI.
- Draw the stereochemistry you actually established; if configuration is unknown or
  relative, say so — and make sure the identifier's stereo layer matches (absent stereo
  markers, not guessed ones).
- For mixtures, polymers, organometallics, and materials that InChI handles poorly or
  not at all, state identity by composition and characterization instead, and note why
  no line identifier is given.
- Verify round-trips before submission: parse your own SMILES/InChI back to a structure
  and compare against the drawn structure — a mismatched identifier is worse than none.
- Use InChIKeys when citing compounds in database or text-mining contexts; they are
  directly searchable in Google, PubChem, and ChemSpider.

## Common pitfalls

- Publishing SMILES with missing or accidental stereocenters (a toolkit default silently
  dropping stereo flags).
- Reporting the parent structure's identifier for the salt, hydrate, or isotopologue
  actually used in the experiments.
- Treating an InChIKey as if the structure could be recovered from it, or truncating it
  to the first block and losing stereochemistry.
- Hand-typing identifiers (transposition errors) instead of exporting from software, and
  not recording the generator version.
- Citing a CAS number found by name-matching without checking the structure, or
  inventing CAS-like numbers for new compounds.
- Burying identifiers in PDF-only SI where they cannot be copied — always provide
  CSV/SDF.

## Canonical links

- https://iupac.org/who-we-are/divisions/division-details/inchi/ — IUPAC InChI division page (standard specification)
- https://www.inchi-trust.org/downloads/ — InChI Trust official software downloads
- https://pubchem.ncbi.nlm.nih.gov/submit — PubChem structure/data submission portal
- https://chem.libretexts.org/Courses/University_of_Arkansas_Little_Rock/ChemInformatics_(2015):_Chem_4399_5399/Text/5_Chemical_Identifiers — comparative overview of chemical identifiers
