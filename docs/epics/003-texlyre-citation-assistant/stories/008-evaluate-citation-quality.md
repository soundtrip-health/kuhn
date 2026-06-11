# Story 008: Evaluate citation quality and hallucination resistance

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Measure whether `/cite` is actually useful and trustworthy enough to continue investing in the pattern.

## Acceptance Criteria

- [x] Create an evaluation set of representative scientific and technical claims
- [x] Measure suggestion validity, relevance, and insertion success
- [x] Record failure modes such as fabricated metadata, weak matches, duplicate results, and empty-result cases
- [x] Recommend concrete follow-up changes to provider selection, ranking, validation, or UX

## Evaluation Set

8 test cases covering biomedical, computer science, psychology, and neuroscience domains.
Each includes a scientific claim, optional author/year hints, and at least one known-good
reference. Test file: `tests/services/citation/evaluation.test.ts`

Run with: `npx jest tests/services/citation/evaluation.test.ts --verbose --no-coverage`

| ID | Domain | Claim (summary) | Hints |
|----|--------|-----------------|-------|
| bio-1 | Biomedical | Gut microbiome influences checkpoint inhibitor efficacy | Gopalakrishnan 2018 |
| bio-2 | Biomedical | Single-cell RNA-seq reveals tumor immune heterogeneity | (none) |
| bio-3 | Biomedical | Psilocybin therapy for treatment-resistant depression | Carhart-Harris 2021 |
| cs-1 | CS/NLP | Transformer self-attention dominates NLP | Vaswani 2017 |
| cs-2 | CS/ML | LLMs exhibit emergent capabilities at scale | Wei 2022 |
| psych-1 | Psychology | Social psychology replication failures | (none) |
| neuro-1 | Neuroscience | Optogenetic modulation of anxiety circuits | (none) |
| doi-1 | Identifier | Direct DOI lookup | 10.1038/nature12373 |

## Results (2026-04-13)

### Summary

| Metric | Value |
|--------|-------|
| Cases evaluated | 8 |
| Known reference found | 4/8 (50%) |
| Average candidates per query | 10.4 |
| Average insertable per query | 10.4 (100% insertability) |
| Average rank when found | 4.3 |

### Per-case results

| ID | Found | Rank | Match label | Candidates | Notes |
|----|-------|------|-------------|-----------|-------|
| bio-1 | No | — | — | 1 | Semantic Scholar rate-limited; only OpenAlex returned results |
| bio-2 | **Yes** | **#1** | strong-match | 18 | Excellent — top result was single-cell immune paper |
| bio-3 | No | — | — | 10 | Carhart-Harris paper not in OpenAlex top results for these keywords |
| cs-1 | No | — | — | 0 | Zero results — arXiv rate-limited, OpenAlex missed "Attention Is All You Need" |
| cs-2 | No | — | — | 18 | Wei 2022 "emergent abilities" not matched; irrelevant results |
| psych-1 | **Yes** | #9 | possible-match | 20 | Replication paper found but ranked low |
| neuro-1 | **Yes** | #6 | possible-match | 15 | Optogenetics result found |
| doi-1 | **Yes** | **#1** | strong-match | 1 | DOI lookup works perfectly |

### Test environment limitations

- **PubMed**: Failed in 5/8 cases due to `DOMParser` not available in Node.js test environment. PubMed works correctly in the browser.
- **Semantic Scholar** (arXiv + PsyArXiv): Rate-limited (429) in 8/8 cases for arXiv and 7/8 for PsyArXiv. Running 8 tests sequentially exceeds Semantic Scholar's unauthenticated burst limit.
- Only **OpenAlex** and **bioRxiv/medRxiv** were reliably available throughout the test run.

## Failure Mode Analysis

### 1. Semantic Scholar rate limiting (Critical)

Both the arXiv and PsyArXiv providers now route through Semantic Scholar's API. With 2 providers × 3 query variants × 8 cases = 48 requests, the unauthenticated rate limit (~1 req/sec) is quickly exceeded. This means:
- CS/ML papers primarily indexed by arXiv become unreachable
- PsyArXiv preprints become unreachable
- The evaluation understates actual quality because the highest-coverage providers are offline

**Impact**: High — eliminates arXiv and PsyArXiv coverage under any sustained usage.

### 2. Keyword extraction produces generic queries (Moderate)

The current regex + stop-word extraction often picks low-signal keywords. Examples:
- bio-1: "composition checkpoint microbiome influence inhibitor" — misses the key phrase "gut microbiome" as a unit
- cs-1: "self-attention architectures transformer processing dominant" — misses the paper's actual title words
- cs-2: "capabilities emergent language exhibit smaller" — too generic

**Impact**: Moderate — OpenAlex returns results, but the results don't always match the specific known-good paper.

### 3. Hint integration doesn't always improve results (Moderate)

When hints include an author name and year (e.g., "Gopalakrishnan 2018"), Variant 2 blends them with keywords: `"Gopalakrishnan 2018 composition checkpoint microbiome"`. This string doesn't trigger OpenAlex's structured search — it's just concatenated text. PubMed-specific structured queries (`[au]`/`[dp]` tags) would work well but PubMed was unavailable in this test.

**Impact**: Moderate — structured search features exist for PubMed/OpenAlex but aren't being leveraged consistently.

### 4. No fabricated metadata detected (Positive)

All 83 total candidates across 8 cases had:
- Valid provenance URLs
- Non-empty titles
- Real author names
- Publication years
- 100% insertability (all passed bibliography metadata requirements)

The grounding pipeline works as designed — zero hallucinated references.

### 5. Deduplication works correctly (Positive)

OpenAlex returned 20 raw results per query but dedup reduced them to 15-18 candidates, correctly merging duplicates from different query variants.

## Recommendations

### Must-fix before production use

1. **Add a shared Semantic Scholar rate limiter.** Both arXiv and PsyArXiv providers use the same API. Implement a global semaphore that limits Semantic Scholar requests to 1/sec across all providers. This is the single highest-impact fix — it restores access to the two most important providers for non-biomedical content.

### Should-fix for quality improvement

2. **Improve structured query generation for OpenAlex.** When hints include author/year, use OpenAlex's `filter=` API (e.g., `filter=authorships.author.display_name:Vaswani,publication_year:2017`) instead of concatenating into free text. The structured-search path already exists for PubMed but not for OpenAlex.

3. **Add Crossref as a discovery provider.** Crossref has broad coverage, good CORS support, and excellent DOI-based metadata. It would complement OpenAlex and reduce dependency on Semantic Scholar.

4. **Extract noun phrases, not individual keywords.** "immune checkpoint inhibitor" and "gut microbiome" are meaningful as phrases but get broken into individual tokens by the current regex extractor. An n-gram or noun-phrase extraction approach would improve query quality without requiring an LLM.

### Nice-to-have

5. **In-browser LLM for query generation (Story 003 follow-up).** A local model would understand that "The music provides a structural holding environment" relates to psychedelic-assisted therapy and could generate much better search queries.

6. **Browser evaluation harness.** The Node.js test environment can't test PubMed (XML parsing requires DOMParser). A browser-based evaluation that runs in Playwright or Puppeteer would test all providers accurately.

## Conclusion

**The `/cite` feature is worth continuing to invest in.** The grounding pipeline is solid — zero fabricated references, 100% insertability, clean deduplication. The main quality gaps are in query generation and rate limiting, both of which are addressable without architectural changes. With the Semantic Scholar rate limiter fix and improved structured query generation, the 50% known-ref-found rate should improve significantly.

## Notes

- This story should be rigorous enough to kill the feature if quality is not there yet
- Evaluation results should inform later `/search` and `/diagram` work
