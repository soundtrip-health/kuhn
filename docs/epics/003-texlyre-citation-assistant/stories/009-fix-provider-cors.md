# Story 009: Fix CORS failures for arXiv and PsyArXiv providers

**Status:** done
**Epic:** [003 — TeXlyre Citation Assistant](../index.md)
**Estimate:** M

## Goal

Make the arXiv and PsyArXiv citation providers work from the browser. Both currently fail with "Failed to fetch" due to CORS restrictions on their APIs.

## Context

The `/cite` pipeline searches all enabled providers in parallel. Two providers fail consistently:

- **arXiv** (`export.arxiv.org/api/query`) — the Atom feed API does not set CORS headers, so browser `fetch()` is blocked by the same-origin policy
- **PsyArXiv** (`api.osf.io/v2/preprints/`) — the OSF API may reject or restrict browser-origin requests

Other providers (PubMed, OpenAlex) work from the browser because their APIs include `Access-Control-Allow-Origin` headers.

## Acceptance Criteria

- [x] arXiv search and ID lookup work from the browser without CORS errors — resolved in Story 011
- [x] PsyArXiv search works from the browser without CORS errors — resolved in Story 011
- [x] bioRxiv and medRxiv are verified to work (they use similar API patterns)
- [x] The solution does not require the user to run a separate backend server for basic usage
- [x] Provider failures are still handled gracefully if a proxy is unavailable

## Options to Evaluate

### Option A: Lightweight CORS proxy

Run a minimal proxy (e.g., a Cloudflare Worker, or a small Express/Hono server) that forwards requests to arXiv/OSF and adds CORS headers. Kuhn could ship with a default proxy URL that users can override.

- Pro: works for all blocked APIs; minimal provider code changes
- Con: adds an external dependency; privacy implications (queries pass through proxy)

### Option B: Server-side search via Kuhn backend

If Kuhn eventually adds a backend (for agent orchestration, compilation, etc.), route provider requests through it.

- Pro: natural fit with the overall architecture direction
- Con: doesn't help until the backend exists

### Option C: Alternative API endpoints

Some services offer CORS-friendly endpoints or alternative access methods:

- arXiv: the main API (`arxiv.org/api`) may behave differently from `export.arxiv.org`; also consider Semantic Scholar API (which covers arXiv and has CORS support)
- PsyArXiv: check if the OSF API works with specific `Accept` headers or if a JSON:API endpoint is less restrictive

### Option D: OpenAlex as arXiv/PsyArXiv proxy

OpenAlex indexes arXiv and PsyArXiv content. For search, OpenAlex already works and returns linked arXiv IDs. For ID lookups, OpenAlex can resolve arXiv IDs and DOIs. This doesn't replace the authoritative providers for validation, but may reduce the need for direct API access.

- Pro: no infrastructure needed; already integrated
- Con: OpenAlex is discovery-layer, not authoritative; metadata may lag

## Notes

- The CORS issue affects only browser-based usage — if Kuhn moves to an Electron or Tauri shell, direct API access would work
- Whatever solution is chosen should be documented so users understand what network requests are made and where they go
- IEEE Xplore has similar constraints and may also need proxy support

## Known Issues

- arXiv: switched to Semantic Scholar API but searches still fail — deferred to [Story 011](011-fix-inline-cite-and-provider-failures.md)
- PsyArXiv: `filter[q]` parameter may not be supported by OSF Preprints v2 — deferred to [Story 011](011-fix-inline-cite-and-provider-failures.md)
