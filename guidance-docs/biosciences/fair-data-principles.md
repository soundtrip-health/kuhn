# FAIR Guiding Principles for Scientific Data Management and Stewardship

> **Kuhn knowledge card.** Canonical source: https://doi.org/10.1038/sdata.2016.18 (Wilkinson et al., Scientific Data 3:160018, 2016). Source access/license: open access (CC BY). This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

The FAIR Principles define what it takes for research data — and the metadata,
code, and workflows around them — to be **Findable, Accessible, Interoperable,
and Reusable**, by machines as much as by humans. They are a framework, not a
standard or a checklist with a certifying body: domain communities implement
them through repositories, metadata schemas, and identifier systems. Funders
(NIH, EU Horizon programs, Wellcome) and journals increasingly expect data
management plans and data availability statements to demonstrate FAIR
practice. Applies to any bioscience output: omics datasets, imaging, clinical
and preclinical measurements, models, and software.

## Key requirements

Each letter unpacks into a few concrete expectations (paraphrased):

**Findable.** Data and metadata get a globally unique, persistent identifier
(DOI, accession number). They are described with rich metadata that explicitly
includes that identifier, and both are indexed in a searchable resource — a
recognized repository, not a lab website.

**Accessible.** The identifier resolves via a standardized, open, free
protocol (in practice, HTTPS), with authentication/authorization where data
are sensitive. Crucially, **metadata remain accessible even if the data are
restricted or withdrawn** — FAIR is not the same as open; controlled-access
human data can be fully FAIR.

**Interoperable.** Data and metadata use formal, shared, machine-readable
vocabularies and formats — community ontologies (Gene Ontology, taxonomy IDs,
units standards) and standard file formats rather than ad hoc spreadsheets —
and include qualified references (typed links) to related datasets.

**Reusable.** Metadata are rich enough for someone else to judge fit for
purpose: a clear usage license, provenance (who generated the data, how, from
what), and conformance to the domain's community standards (e.g., MIAME for
microarrays, MINSEQE for sequencing, mmCIF for structures).

The bioscience implementation pattern: deposit each data type in its
discipline repository — sequence reads to SRA/ENA, expression to GEO or
ArrayExpress, proteomics to PRIDE, structures to the PDB, general data to
Zenodo/Dryad/Figshare — which supplies the identifier, metadata schema,
protocol, and license machinery.

## How to apply when writing

- **Data availability statement**: name the repository, give the accession
  number or DOI for every dataset, state access conditions (open, embargoed
  until publication, or controlled access with the application route), and the
  license. "Data available on reasonable request" is widely considered
  FAIR-deficient; use it only where law or consent genuinely forbids deposit,
  and say why.
- **Deposit before submission** so accessions exist for the manuscript;
  repositories support reviewer tokens for pre-publication confidential
  access.
- **Methods**: identify materials with resolvable identifiers — gene symbols
  per HGNC, organisms per NCBI Taxonomy, antibodies/cell lines via RRIDs,
  chemicals via standard identifiers — so the text itself is interoperable.
- **Code and workflows**: archive the analysis code with its own DOI (e.g.,
  a Zenodo snapshot of the repository) and cite the exact version used.
- **Cite data properly**: reference reused datasets in the bibliography with
  their persistent identifiers, not just inline URLs, so data generators get
  credit and provenance chains stay intact.
- For human-subjects data, describe the controlled-access mechanism (e.g.,
  dbGaP application) rather than withholding silently — restricted but
  well-described beats invisible.

## Common pitfalls

- Equating FAIR with open: publishing sensitive data without governance, or
  conversely refusing to share metadata because the data are restricted.
- "Available from the corresponding author on request" as the entire data
  statement — no identifier, no repository, no durability.
- Depositing files in a general repository with a bare title and no
  structured metadata, license, or links to the paper — findable in name only.
- Supplementary files as the sharing mechanism: paywalled, poorly indexed, no
  independent identifier, and frozen in non-machine-readable formats (data
  tables as PDFs).
- Omitting a license, which leaves reusers legally unable to reuse even
  perfectly accessible data.
- Sharing processed results but not the raw data and code needed to
  regenerate them, breaking provenance.

## Canonical links

- https://doi.org/10.1038/sdata.2016.18 — the FAIR principles paper (Wilkinson et al., 2016)
- https://www.go-fair.org/fair-principles/ — GO FAIR's principle-by-principle implementation guidance
- https://osp.od.nih.gov/policies/scientific-data-management-policy/ — NIH Data Management and Sharing Policy (FAIR in funder practice)
