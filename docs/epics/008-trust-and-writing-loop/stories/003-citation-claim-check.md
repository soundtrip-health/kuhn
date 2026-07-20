# Story 008-003: Citation claim-checking

**Status:** draft
**Epic:** [008 — Trust & the Writing Loop](../index.md)
**Estimate:** L

## Goal

The Reviewer verifies that every `[@key]` citation in a document actually
supports the sentence it is attached to, and reports a grounded verdict per
citation. This is the scientific-integrity feature: "Kuhn checks that your
citations say what you think they say."

## Sketch

- **Extraction:** walk the document for citation chips; capture each with its
  enclosing sentence/claim (the chip is a ProseMirror atom — position and
  surrounding text are exact, no fuzzy matching needed).
- **Evidence:** per cited key, retrieve what we hold — `bib_references`
  stores title/abstract/DOI/PMID today. Where the paper is open-access,
  fetch full text via PMC/NCBI efetch (the `citations.js` rate limiter
  already governs NCBI traffic). No evidence → verdict is `cannot-verify`,
  never a guess.
- **Judgment:** one focused model call per claim–evidence pair:
  `supports | partially-supports | does-not-support | cannot-verify`, with a
  quoted evidence snippet for every verdict that isn't `cannot-verify`.
  Verdicts must be grounded in retrieved text only — the prompt forbids
  judging from memory of the paper.
- **Surface:** a per-document report (`research/citation-check-<doc>.md`)
  listing each claim, verdict, and evidence quote, plus chat summary counts.
  Once 008-004 lands, verdicts also attach as margin comments on the chips.
- **Trigger:** on demand — a `/check-citations` command and a Reviewer chat
  ask. Not automatic on save (costs tokens; the PI runs it before submission).

## Acceptance Criteria

- [ ] Every `[@key]` in the target document gets exactly one verdict; keys
      missing from the bib are reported as broken references.
- [ ] Every non-`cannot-verify` verdict carries a quoted evidence snippet
      from the retrieved abstract/full text.
- [ ] `cannot-verify` is an honest outcome (paywalled, no abstract), clearly
      distinguished from `does-not-support`.
- [ ] Report file + chat summary ("21 checked: 16 support, 2 partial, 1
      contradicted, 2 unverifiable"); re-runs replace the report.
- [ ] Token spend for a full-document check is visible and bounded (ties into
      009-003).

## Notes

- The verdict taxonomy matters medico-legally: `does-not-support` is a claim
  about the evidence retrieved, not about the paper as a whole — the report
  header must say so.
- Semantic Scholar was already recommended by the Epic 003 eval as a second
  metadata source; if added (009-002 shares the need), its TLDRs/abstracts
  feed this story's evidence pool.
