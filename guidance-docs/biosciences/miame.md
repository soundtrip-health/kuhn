# MIAME and the Minimum-Information Family (MIxS, MINSEQE, MIQE)

> **Kuhn knowledge card.** Canonical source: https://www.ncbi.nlm.nih.gov/geo/info/MIAME.html (NCBI Gene Expression Omnibus; standard authored by the MGED/FGED Society). Source access/license: open access via NCBI (US government site); the standard itself is a community specification. This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

MIAME (Minimum Information About a Microarray Experiment) defines the minimum
data and metadata that must accompany a published microarray experiment so
that readers can interpret the results and, in principle, reproduce the
analysis. It is enforced in practice by the two major expression repositories
— GEO (NCBI) and ArrayExpress/BioStudies (EMBL-EBI) — and by journals that
require MIAME-compliant deposition before publication. MIAME is also the
prototype of a much larger "minimum information" family covering most
high-throughput bioscience methods: MINSEQE for sequencing-based functional
genomics, MIQE for qPCR, and the MIxS checklists for genome/metagenome
sequences, among dozens coordinated historically under the MIBBI/FAIRsharing
umbrella. When writing up any omics experiment, the question is always "which
minimum-information checklist governs this data type, and does our deposit
satisfy it?"

## Key requirements

MIAME requires six kinds of information (paraphrased):

1. **Raw data** — the unprocessed output for each hybridization (e.g., the
   scanner's native result files such as CEL files), not just final numbers.
2. **Processed (normalized) data** — the final expression matrix on which the
   paper's conclusions rest.
3. **Sample annotation** — what each sample is and how it was handled:
   organism, tissue/cell type, disease state, treatment, and the experimental
   factors distinguishing samples.
4. **Experimental design** — the structure relating samples to data files:
   which samples were compared, replicate structure (biological vs technical),
   and hybridization layout.
5. **Array annotation** — enough about the platform to interpret features:
   the array design, probe identities and sequences or database accessions.
6. **Protocols** — laboratory and data-processing procedures: extraction,
   labeling, hybridization, scanning, and the normalization/summarization
   algorithms with their parameters.

Companion standards extend the same logic: **MINSEQE** asks the equivalent for
sequencing experiments (sample descriptions, raw reads such as FASTQ,
processed summaries, experimental design, protocols including library prep
and analysis pipeline). **MIQE** does it for quantitative PCR (assay design,
primer sequences, validation, efficiency, Cq handling). **MIxS** (Genomic
Standards Consortium) packages environmental/contextual metadata for genome
and marker-gene sequences. Repositories operationalize these checklists via
their submission templates (GEO's spreadsheet formats, SRA/ENA metadata,
BioSample attributes), so a complete, well-annotated deposit is the compliance
mechanism.

## How to apply when writing

- **Deposit first, then write.** Submit the complete dataset (raw plus
  processed data with full sample annotation) to GEO or ArrayExpress before
  manuscript submission; obtain the accession (e.g., a GSE series ID) and a
  reviewer access token for private review.
- In the **data availability statement**, cite the repository and accession
  explicitly, and state that the deposit follows the applicable
  minimum-information standard.
- In **Methods**, mirror the checklist: platform name and version, sample
  numbers with biological/technical replicate structure, RNA extraction and
  labeling protocols, and the exact preprocessing pipeline — software,
  versions, normalization method, filtering thresholds.
- Describe **experimental factors** in the same vocabulary as the repository
  annotation, so the paper and the deposit tell one consistent story.
- For sequencing studies, apply MINSEQE via SRA/ENA + GEO deposits (raw reads,
  processed matrices, pipeline description); for qPCR results supporting the
  paper, report MIQE items (primer sequences, efficiencies, reference-gene
  justification, Cq method) in methods or supplements.
- When reusing public microarray/sequencing data, cite the original accessions
  and note any reprocessing you performed.

## Common pitfalls

- Depositing only the normalized expression matrix — omitted raw files are the
  single most common MIAME failure and block independent reanalysis.
- Sample annotations like "sample1…sample12" with the factor levels (genotype,
  treatment, timepoint) only decipherable from the paper's figure legends.
- Not distinguishing biological from technical replicates, making the
  statistical claims unverifiable.
- Describing normalization as just "data were normalized" without algorithm,
  software, version, or parameters.
- Custom or modified arrays without probe-level annotation, leaving features
  uninterpretable.
- Promising "data available upon request" for a data type that has a mandatory
  public repository — journals following MIAME/MINSEQE will not accept this.

## Canonical links

- https://www.ncbi.nlm.nih.gov/geo/info/MIAME.html — MIAME as applied by GEO
- https://www.fged.org/projects/minseqe/ — MINSEQE (sequencing-experiment minimum information)
- https://www.gensc.org/pages/standards-intro.html — MIxS checklists (Genomic Standards Consortium)
- https://fairsharing.org/ — registry of minimum-information standards and matching repositories
