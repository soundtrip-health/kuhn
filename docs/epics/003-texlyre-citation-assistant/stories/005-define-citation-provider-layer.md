# Story 005: Define configurable citation providers and validation rules

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** L

## Goal

Create the source abstraction and validation policy that keep `/cite` grounded in real literature sources.

## Acceptance Criteria

- [x] Define a provider interface covering search, fetch, normalization, and provenance metadata
- [x] Define user configuration for enabling, disabling, and prioritizing providers
- [x] Define how structured and unstructured user hints are translated into provider queries without weakening validation
- [x] Specify normalization rules for core metadata fields such as title, authors, year, DOI, PMID, arXiv ID, and URL
- [x] Specify validation rules that prevent unsupported or partially verified references from being suggested
- [x] Document the initial provider set and any caveats around APIs, quotas, or access requirements

## Provider Layer Contract

### Design Goal

The provider layer exists to make `/cite` source-grounded by construction. It should accept context-derived search requests, talk to enabled literature sources, normalize results into a shared schema, validate them, and emit only records that are safe to show or insert.

The provider layer must integrate cleanly with TeXlyre's current bibliography flow, which already uses a `BibEntry`-style record for imported entries.

## Core Data Model

### `CitationSearchRequest`

Represents one retrieval attempt triggered by `/cite`.

Required fields:

- `targetText`: the selected text or previous sentence(s) being cited
- `rawHints`: the raw user hint string after `/cite`, if any
- `parsedHints`: extracted clues such as authors, years, title fragments, IDs, and keywords
- `queries`: one or more generated search queries
- `enabledProviders`: ordered list of provider IDs to query

### `ParsedCitationHints`

Represents extracted hints from `/cite`.

Fields:

- `authors`: string[]
- `years`: string[]
- `titleFragments`: string[]
- `identifiers`: object with optional `doi`, `pmid`, `arxivId`
- `keywords`: string[]
- `freeTextRemainder`: string

Rule:

- Parsed hints are retrieval aids only
- Parsed hints must never be promoted to verified metadata without provider confirmation

### `NormalizedCitationRecord`

Represents a provider-returned result after normalization.

Required fields:

- `providerId`
- `providerName`
- `providerRecordId`
- `provenanceUrl`
- `title`
- `authors`: string[]
- `year`
- `recordType`

Optional but strongly preferred fields:

- `abstract`
- `journal`
- `booktitle`
- `publisher`
- `volume`
- `issue`
- `pages`
- `doi`
- `pmid`
- `pmcid`
- `arxivId`
- `url`
- `pdfUrl`
- `preprintServer`
- `citationCount`
- `publishedDate`

Operational fields:

- `rawProviderRecord`
- `matchedHints`
- `validationStatus`
- `validationWarnings`
- `rankingSignals`

### `ValidatedCitationCandidate`

Represents a record safe to show in the `/cite` results UI.

Fields:

- `normalizedRecord`: `NormalizedCitationRecord`
- `matchLabel`: `strong-match | possible-match | hint-match-low-context-support`
- `explanation`: short evidence-based reason the result was surfaced
- `insertable`: boolean

Rule:

- Only validated candidates may be rendered as selectable citation suggestions

## Provider Interface

### Required Methods

- `search(request, query): Promise<ProviderSearchResult[]>`
- `fetchById(id): Promise<ProviderSearchResult | null>`
- `normalize(record): NormalizedCitationRecord | null`
- `validate(record): ProviderValidationResult`
- `toBibEntry(record): BibEntry`

### Required Provider Metadata

- `id`
- `name`
- `kind`: `authoritative | discovery | personal-library`
- `supportsStructuredAuthorSearch`
- `supportsYearFiltering`
- `supportsIdentifierLookup`
- `requiresAuth`
- `defaultEnabled`

### Interface Rules

- `search` returns raw provider-native results and must preserve enough metadata for later auditing
- `normalize` maps raw provider data into the common schema
- `validate` performs provider-specific checks before shared validation runs
- `toBibEntry` must emit a TeXlyre-compatible imported bibliography record

## Query Construction Rules

### Inputs

Queries may be built from:

- citation target text
- raw hint string
- parsed author/year/title/identifier hints
- provider capabilities

### Strategy

- Generate a small number of precise queries rather than many broad ones
- Prefer identifier lookup when a DOI, PMID, or arXiv ID is present
- Prefer author plus year plus topic queries when hints are partial
- Use different query shapes for different providers when their APIs support fielded search

### Safety Rule

- Query construction may use the local LLM, but the provider layer must treat query text as untrusted input
- Search hints influence recall only; they do not raise validation status

## Shared Validation Rules

### Minimum Metadata for Suggestion

A record may be shown as a suggestion only if it has:

- non-empty title
- at least one author or a recognized organizational author
- a publication year or sufficiently precise publication date
- stable provenance back to the originating provider

### Minimum Metadata for Insertion

A record may be inserted into project bibliography only if it has:

- all suggestion requirements
- enough metadata to produce a valid `BibEntry`
- a stable provider identity such as DOI, PMID, arXiv ID, or durable provider record ID

### Rejection Conditions

Reject a record if:

- title is missing or obviously corrupted
- authorship is missing and cannot be reasonably inferred from provider data
- year is missing and no precise date is available
- the record is clearly a non-scholarly artifact for the active provider set
- duplicate records disagree materially on core metadata
- provenance cannot be traced to a real provider result

### Warning Conditions

Allow downgraded display but not default insertion when:

- the record is a preprint where a published version may exist
- author list is truncated by the provider
- metadata is sparse but still traceable
- the result matches user hints more strongly than local context

## Ranking Rules

Ranking should be conservative and evidence-based.

Primary signals:

- semantic relevance to `targetText`
- agreement with parsed hints
- identifier exact match
- author plus year agreement
- title-fragment agreement
- provider authority level

Secondary signals:

- citation count
- recency when the claim implies recent work
- presence of fuller metadata

Rules:

- Exact identifier matches outrank all fuzzy matches
- Author-year hint matches do not outrank stronger context matches if metadata quality is weak
- Discovery-provider results should rank below authoritative-provider results when both resolve to the same work

## Duplicate and Provenance Handling

### Deduplication

The layer should merge equivalent records across providers using:

- DOI
- PMID
- arXiv ID
- provider-stable IDs
- normalized title plus author plus year fallback

### Provenance Preservation

- Keep all source-provider hits attached to the merged record
- Preserve which provider supplied which metadata fields
- If OpenAlex or another discovery layer finds a paper that is then confirmed elsewhere, the confirmed source should become the primary provenance

## User Configuration Contract

Users should be able to configure:

- enabled providers
- provider priority order
- whether discovery-only providers are allowed
- whether personal-library providers such as Zotero participate in `/cite`
- mailto or API settings where required by a provider

Project-level defaults should exist, with sensible initial defaults:

- enabled: PubMed, arXiv, bioRxiv, medRxiv, PsyArXiv, OpenAlex
- conditional: IEEE Xplore if access and API constraints are satisfied
- optional: Zotero for users who want library-aware suggestions

## Mapping to TeXlyre Bibliography Records

Inserted results should map into TeXlyre's existing `BibEntry` shape:

- `key`
- `entryType`
- `fields`
- `rawEntry`
- `source: 'external'`
- `isImported: true`
- `providerId`
- `providerName`
- `remoteId`

Rules:

- `key` generation must be deterministic enough to avoid duplicate imports
- `fields` should preserve normalized metadata with provider-specific extras only where useful
- `rawEntry` should be generated from validated normalized metadata, not copied blindly from arbitrary provider text

## Initial Provider Notes

### PubMed

- Strong authoritative source for biomedical literature
- Prefer PMID lookup when available
- PubMed records may need enrichment for BibTeX mapping

### arXiv

- Authoritative for arXiv-hosted preprints
- Use arXiv ID exact matching when possible
- Distinguish preprint records from later journal publications

### bioRxiv and medRxiv

- Authoritative for their own preprint servers
- Expect preprint-specific metadata and possible later published versions

### PsyArXiv

- Useful but may expose metadata differently than arXiv-family sources
- Validate identifiers and URLs carefully

### IEEE Xplore

- Valuable for engineering and CS literature
- API/access model may constrain first-pass support
- Keep first implementation flexible if direct integration is blocked

### OpenAlex

- Good discovery layer and metadata linker
- Should not automatically outrank more authoritative source-specific records
- Preserve original provenance if OpenAlex points to another canonical source

### Zotero

- Personal-library source, not a general authoritative index
- Useful for users who already curate references
- Should remain optional and clearly distinguished from external literature search

## Notes

- OpenAlex may be useful as a discovery layer, but `/cite` should preserve provenance from the authoritative source used
- IEEE Xplore may require special handling depending on access and API constraints
- This story is the implementation contract for provider adapters, normalization, validation, and bibliography insertion

## Notes

- OpenAlex may be useful as a discovery layer, but `/cite` should preserve provenance from the authoritative source used
- IEEE Xplore may require special handling depending on access and API constraints
