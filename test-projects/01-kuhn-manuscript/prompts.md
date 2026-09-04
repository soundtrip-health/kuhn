# Prompts — Kuhn manuscript test project

Run in order. Each step lists the agent (or UI surface), the prompt to send
verbatim, and what to check before moving on. Steps marked *(optional)* need
extra images but exercise otherwise-uncovered paths.

## §1 Setup wizard (token-free intake)

| Field | Value |
|---|---|
| Project type | Manuscript |
| Title | `Scientific writing with AI` |
| Research question | `How can AI be used for rigorous, fact-based scientific writing? The manuscript is about the Kuhn project itself — the open-source multi-agent writing framework this very project is running on.` |
| Deliverables | `manuscript to submit to NeurIPS 2027` |
| Timeline | `Draft by December 2026, submission ready by April 2027` |
| Uploads | the 4 files from `seed-docs-upload/` (run `./collect-seed-docs.sh` first) |
| Final step | **Launch research + skeleton now** |

**Check:** chat shows "▶ background research…" (RA + Advisor interleaved) then
"▶ skeleton draft…" then "✓ project seeding done". Files appear:
`project.json`, `draft/references.bib`, `research/literature-summary.md`,
`guidance/index.md` (+ per-seed-doc summaries), `draft/main.md`, `pm/status.md`.

## §2 PM — orientation

> Give me a status report: what has been set up in this project so far, what's in the draft, and what you see as the next three concrete steps.

**Check:** PM reads workspace files (file_read events), answers grounded in
`pm/status.md` / `project.json` — no invented files or stages.

## §3 RA — grounded citation

> Find a recent empirical paper measuring how often large language models fabricate bibliographic citations, and add it to the bibliography with a one-line note in research/literature-summary.md on why it matters for this manuscript.

**Check:** chat shows "📚 ra added citation [@key]"; `draft/references.bib`
gains a real entry (verify the DOI/PMID resolves); the summary cites the new
`[@key]`, not a made-up one.

## §4 Advisor — venue guidance

> What reporting and reproducibility expectations should we plan for if we target NeurIPS 2027 (checklists, ethics statements, artifact/code expectations)? Write your recommendations to guidance/neurips-2027-checklist.md.

**Check:** file created under `guidance/`; recommendations are hedged where the
advisor could not verify current-year specifics (no fabricated URLs/policies).

## §5 Writer — cited expansion (suggestion mode)

> Expand the Introduction of draft/main.md: two paragraphs motivating structural guarantees over "better prompting", citing only keys that already exist in draft/references.bib. Leave [TODO] markers for any claim you cannot support.

**Check:** the edit arrives as a **pending suggestion** (diff to review in the
editor), not a silent overwrite; accepting it updates `draft/main.md`; every
`[@key]` used exists in the .bib.

## §6 Reviewer — critical pass

> Do a critical review of draft/main.md: verify every citation-backed claim against references.bib, list unsupported claims, and write the review to research/reviews/e2e-review-1.md.

**Check:** review file written; findings reference real line/section locations;
reviewer did **not** edit the draft itself.

## §7 Analyst — small deterministic task *(optional; needs `kuhn/r-analysis:latest` built)*

> Write and run a small R script that counts the [@key] citations per top-level section of draft/main.md and writes the result to a table the writer can use (citation density per section).

**Check:** analyst writes the script under `analyst/`, executes it via
`run_script` (sandboxed; a script-run row is recorded), and the output lands as
a structured table (CSV) under `draft/tables/` or is copied from
`analyst/output/run-<id>/` — not hand-typed numbers.

## §8 Editor — `/cite`, preview, export

1. In the editor, type `/cite` in a paragraph, search `hallucination large language models citations`, pick a candidate.
   **Check:** styled chip inserted; `draft/references.bib` gains the entry; citing the same paper again reuses the key.
2. Click **Preview** → **Render**.
   **Check:** PDF renders with formatted citations and a bibliography; no `.preview-*.typ` litter in the tree.
3. Export **.docx** and **.tex**.
   **Check:** both download and open (docx in Word/Pages; tex contains `\documentclass`).

## §9 Slides *(optional; needs a marp image)*

> Create slides/kuhn-eli5.md — a short Marp slide deck (marp front matter) explaining Kuhn to a smart 10-year-old: the problem (AI makes stuff up), and how Kuhn's guarantees keep the writing honest. List the available slide themes first and pick a sensible one.

**Check:** deck written with `marp: true` + a `theme:` from the listed themes;
it renders in the preview pane.

## §10 Resilience

Reload the browser tab mid-conversation, then send:

> continue

**Check:** transcript restores ("— restored transcript —", "↺ resumed
session(s)"); the agent continues with prior context intact.
