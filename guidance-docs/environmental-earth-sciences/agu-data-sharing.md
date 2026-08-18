# AGU Data and Software Sharing and Citation Guidance

> **Kuhn knowledge card.** Canonical source: https://data.agu.org/resources/agu-data-software-sharing-guidance (American Geophysical Union). Source access/license: freely accessible; published under CC BY 4.0 — generous summarization permitted. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

AGU's guidance for authors submitting to its journals (JGR family, GRL, AGU Advances, Earth's Future, Water Resources Research, and others) sets the earth- and space-science standard for making the **data and software underlying a paper** available, cited, and preserved. AGU treats data and software as building blocks of the research, on par with the text: results must be verifiable and reusable.

The policy operationalizes the FAIR principles and the "Enabling FAIR Data" community commitment that AGU led. It applies to observational data, model output and configurations, laboratory measurements, field data, and the software/scripts that produce the reported results and figures. Similar expectations now apply across most earth-science journals, so the guidance travels well beyond AGU.

## Key requirements

**Availability statements are mandatory.** Every submission includes an **Availability Statement** (formerly "Data Availability Statement," now covering software too) in a dedicated back-matter section — *not* only in supporting information:

- It must say what data and software underlie the paper and exactly where and how to get them, with links and persistent identifiers.
- Templates cover the standard cases: data in a repository (preferred); data from third-party sources (cite them); restricted data (state the legal/ethical restriction and the access route); and — rarely acceptable — no new data.
- "Data available from the author on request" and personal or lab websites do **not** satisfy the policy.

**Repository deposit, not supplements.** Data and software must be deposited in **trusted, persistent repositories** that issue DOIs and maintain landing pages with metadata:

- Discipline-specific repositories where they exist (e.g., NASA/NOAA/USGS archives, PANGAEA, EarthChem, IRIS); general-purpose repositories (Zenodo, Dryad, Figshare) otherwise.
- Supplementary files attached to the article are not an acceptable home for primary data.
- Deposits should happen before or at submission so reviewers can access them (anonymous or embargoed review links where the repository supports them).

**Formal citation.** Datasets and software are cited **in the reference list**, not just linked in the availability statement:

- Creator(s), year, title, version, repository/publisher, and persistent identifier — following the FORCE11 data-citation and software-citation principles.
- This applies to reused third-party data as much as to newly generated data.
- In-text pointers connect each result to the cited dataset or software.

**Software specifics.** Scripts, models, and workflows essential to the findings should be:

- Released under an open license and documented well enough to rerun (dependencies, configuration, inputs).
- Archived with a version-specific DOI — e.g., a tagged release preserved in Zenodo rather than a mutable GitHub URL.
- Community or commercial software: cite with name and exact version.

**Metadata and preservation.** Deposits need rich, standards-based metadata (variable definitions, units, geospatial and temporal coverage, instruments, processing level) so the data are findable and interoperable, in a repository committed to long-term preservation.

## How to apply when writing

- **Plan deposit early** — pick repositories during the research, not at submission; repository ingest and DOI minting take time.
- **Write the Availability Statement concretely:** one sentence per dataset/software item — what it is, repository name, DOI, license, and any access conditions. Mirror each item with a full reference-list entry, and cite those references from the statement and from Methods.
- **Methods:** name every third-party dataset (with version or access date for evolving products) and every model/software version used; connect figures and key results to the specific archived files or scripts that produce them (a "reproduce the figures" script or README mapping helps reviewers).
- **Restricted data:** state the specific restriction (proprietary, confidentiality, national regulation), who can access it and how, and archive whatever *can* be shared — derived products, metadata, and the processing code.
- **Version pinning:** cite the exact released version used; if data are updated later, the paper's citation should still resolve to the version analyzed.
- **Check journal specifics:** some AGU journals add plain-language summary requirements and graphics standards — see AGU author policies alongside the data guidance.

## Common pitfalls

- "Data available upon request" or a lab-website link instead of a repository DOI — grounds for return without review.
- Putting primary data only in supporting-information PDFs or spreadsheets attached to the article.
- Linking a live GitHub repository instead of an archived, versioned release with a DOI.
- Citing data only in the availability statement and omitting the reference-list entry (loses credit and traceability).
- Forgetting third-party data: reanalysis, satellite, or survey products used but never formally cited with version and identifier.
- Depositing files with no metadata, units, or README, making the "available" data effectively unusable.

## Canonical links

- AGU data & software sharing guidance (canonical): https://data.agu.org/resources/agu-data-software-sharing-guidance
- AGU author policies (text, graphics, AI, plain-language summaries): https://www.agu.org/publications/authors/policies
- FORCE11 Joint Declaration of Data Citation Principles: https://force11.org/info/joint-declaration-of-data-citation-principles-final/
