# Story 010: Improve citation search quality with NLP and multi-variant queries

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** L

## Goal

Improve `/cite` search relevance before an intelligent agent is available by adding lightweight NLP-based keyword extraction and smarter query construction.

## Context

The current `buildQueries()` function is intentionally simple — it concatenates hint tokens and truncates the target sentence. This produces generic queries that miss domain-specific terminology and treat all hint tokens uniformly (e.g., an author name is sent as a general keyword rather than an author field). The result is noisy recall with many irrelevant hits.

Three complementary improvements can raise search quality without adding an LLM:

1. **Document-level keyword extraction** — maintain a running summary of the document's topics and key terms
2. **Context-specific keyword extraction** — extract meaningful terms from the specific sentence being cited
3. **Multi-variant query generation** — launch parallel search variants that interpret hints differently

## Acceptance Criteria

- [x] Extract document-level keywords using basic NLP (pure regex + stop-word filtering in `extractKeywords.ts` — no external library dependency)
- [x] Maintain a lightweight keyword cache that updates as the document changes (`DocumentKeywordService` — debounced 3s, updated synchronously on `/cite` invocation)
- [x] Extract context-specific keywords from the citation target text, filtering out stop words and common LaTeX/Typst markup
- [x] Include document-level and context-specific keywords in provider search queries
- [x] Generate multiple query variants per search, including at least:
  - A structured query that treats author-like hint tokens as author fields (PubMed: `[au]`/`[dp]` tags; OpenAlex: `filter=` params)
  - A title/topic query using extracted keywords (Variant 1)
  - A broad query using the original target text (Variant 3 — fallback)
- [x] Providers that support structured search (PubMed, OpenAlex) receive field-specific queries
- [ ] Search quality improves measurably on the evaluation set from Story 008 — pending Story 008 evaluation set

## Technical Approach

### Document keyword extraction

- Use [retext-keywords](https://github.com/retextjs/retext-keywords) or a similar lightweight NLP library that runs in the browser
- Extract keyphrases and key terms from the full document text
- Cache the result and recompute on document changes (debounced, e.g., 5 seconds after last edit)
- Store as a service (`DocumentKeywordService`) that the citation pipeline can query

### Context-specific extraction

- For the citation target text, run a simpler extraction pass:
  - Remove LaTeX/Typst commands
  - Remove common stop words
  - Extract noun phrases or significant terms
  - Weight terms that appear in the document keyword set higher

### Multi-variant query generation

Upgrade `buildQueries()` in `CitationProviderService` to produce multiple query variants:

```
Input: targetText="We observed significant improvements in language modeling performance"
       hints="Vaswani 2017"

Variant 1 (structured): author:"Vaswani" year:2017 (for providers with structured search)
Variant 2 (topic):      "language modeling" "attention" (from context + doc keywords)
Variant 3 (broad):      "We observed significant improvements in language modeling performance" (current)
Variant 4 (hint+topic): Vaswani 2017 language modeling attention
```

Each variant is sent to each provider. Results are merged, deduplicated, and ranked as before.

### Provider-specific query formatting

- PubMed: use `[au]` and `[dp]` field tags when author/year hints are present
- OpenAlex: use `filter` parameters for author, year, and concept fields
- Other providers: fall back to general text query with hint tokens included

## Dependencies

- Story 008 (evaluation set) is needed to measure improvement, but development can proceed in parallel

## Notes

- This is a pre-LLM improvement layer — when the in-browser model is ready (Story 003 follow-up), it can replace or augment the NLP extraction and query generation
- The document keyword cache should be designed so the LLM can later consume or refine it
- Keep the keyword extraction lightweight — it runs on every document change and must not block the editor
- retext-keywords is ~15KB gzipped and runs synchronously, making it suitable for browser use
