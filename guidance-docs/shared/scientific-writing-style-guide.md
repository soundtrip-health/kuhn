# Scientific writing — prose craft and claim calibration

Cross-cutting writing guidance for the shared corpus, applicable to every project
type. The Writer applies it while drafting; the Reviewer cross-checks against it;
the PM uses it as a pre-review sanity check. Sources: Clark, *Everyone Can Write
Better* (1999); *Effective Scientific Writing* (Lewis & Clark Biology); and, for
formatting house style, T. J. Aragón, *Practical LaTeX for the Health Sciences*
(2016).

> **Conventions note.** Kuhn uses `[Author, Year]` in-text citations and
> `[TODO: ...]` / `[TODO: verify: ...]` / `[TODO: citation needed: ...]`
> markers (see the agent prompts). This guide uses those forms. Reviewer and PI
> feedback lives in `review/reports/` and PM status files, not inline markers.

**The goal is to communicate, not to impress.** Every feature that makes prose
harder to read costs a reader.

## 1. Calibrate every claim to its evidence *(the highest-yield rule)*

- Match the strength of the language to the strength of the evidence — distinguish
  sure conclusions from tentative ones *through the words you choose* ("shows" vs.
  "suggests" vs. "is consistent with"). State speculation as speculation.
- Do not overstate magnitude. "Agree well," "strong," "excellent" must be earned by
  the number, not asserted over it. If a statistic is moderate, say "moderate."
- Do not state a conditional result as a law. Name the assumptions where the claim
  is made.
- Observational data describe **association, not cause**, unless a causal design and
  its assumptions are explicit.
- Quantify. Report effect direction *and* size with uncertainty (SD, SE, 95% CI),
  not just significance. Lead with what was found; demote the test (`F`, `p`, model
  name) to a subordinate clause.
- Surface genuine uncertainty with `[TODO: verify: …]` rather than papering over it.

## 2. Structure for the reader

- **Given-before-new.** Open a sentence with familiar information; close with the
  new point. English expects emphasis at the end.
- **Topic sentences.** Every paragraph opens with an orienting sentence stating its
  point.
- **One idea per paragraph; logically connected.** Move from broad to specific.
- **State assertions directly**; do not pose "why" headings or rhetorical questions.
  Write "Equipoise drives the design," not "Equipoise: why it matters."
- **Use IMRaD, not a business format.** Title, abstract, Introduction, Methods,
  Results, Discussion, Conclusion, References. **The Introduction is the first
  section**; background and prior work belong inside it, not as a peer section ahead
  of it. Do **not** add an "Executive summary" — the standalone summary goes in the
  **abstract**; motivation and research question go in the **Introduction**. The
  abstract states question, method, findings (with key numbers), and meaning, in one
  paragraph and without citations.
- **Support every claim** with data or a `[Author, Year]` citation to peer-reviewed
  evidence; label author judgment as judgment.

## 3. Cut what does not work

- Eschew surplusage — "It has been discovered that X" → "X."
- Never write a word you would not say aloud: *use* not *utilize*, *about* not *with
  regard to*, *before* not *prior to*, *so* not *accordingly/hence/thus*, *if* not
  *in the event that*.
- Split complicated sentences into two or three.
- Root out empty adjectives/adverbs: intensifiers ("very," "extremely") that invite
  overstatement; evaluative words ("interesting," "novel," "surprising," "important")
  that presume the reader's judgment; filler adverbs ("basically," "essentially,"
  "simply").
- Avoid nominalizations the first time you name an action ("people compute
  covariation," not "covariance computation occurs"). Technical nominalizations that
  *are* the concept ("remission," "estimand") stay.
- Do not open with empty "it" or "there is" when a direct subject works.
- Drop unnecessary "which"; use "that" in restrictive clauses.

## 4. Voice, syntax, punctuation

- Prefer the active voice where it reads naturally. The passive is acceptable when
  the actor is irrelevant or obvious (much of Methods); do not contort prose to
  avoid it. (A linking verb — *is*, *was*, *has* — is not the passive voice.)
- Center prose on the subject matter (patients, treatments, mechanisms), not prior
  authors. Put citations in subordinate position ("PHQ-9 and MADRS agree moderately
  `[Hawley, 2013]`", not "Hawley (2013) showed that…") — reserve author-subject
  framing for when the author *is* the point.
- Limit em-dashes; use colons and semicolons as the primary tools for linking
  clauses.
- Quote sparingly; paraphrase and cite; avoid block quotations.

## 5. Word-level correctness

- *affect* (verb) vs. *effect* (noun); *experiment* vs. *observation*;
  *fewer/number* (discrete) vs. *less/amount* (continuous).
- *Data* are plural in formal scientific prose.
- Units on every number; consistent notation, units, and time windows across
  sections.
- Spell-check — typos read as carelessness.

## 6. Process

- A scientific document answers four questions: what was done, why, what was found,
  what it means. Outline before drafting; trace the logic and check it is internally
  consistent.
- No document reaches the PI unreviewed — the Reviewer is the mandatory gate.
- **Keep internal tooling out of externally-facing drafts.** A manuscript, memo, or
  any shareable document must not name repo-internal code paths, script/pipeline
  filenames, DB schemas, or output directories. Reproducibility and code detail
  belong in a sibling record (e.g. a `provenance.md` or analysis spec), so a tool
  reference cannot slip into a final product. Compose the external data/code-
  availability statement in the venue's format at submission time.

## Writing style reference

### Voice and tense

- Methods/design: past or present tense consistently within a section; active voice
  where natural; avoid awkward personalization.
- Results: past tense for observed findings.
- Discussion/conclusions: present tense for established claims, past for specific
  study findings.

### Emphasis and punctuation

- **Do not highlight words or phrases inside running text.** Bold and italic are for
  structural labels, not mid-paragraph emphasis. Acceptable bold: headings, run-in
  list-item labels, table row/column labels, a defined term at first use. If a point
  matters, carry it with sentence structure and word choice. Use italic sparingly
  (terminological emphasis, publication titles).
- **Use the em-dash (—) sparingly.** Prefer a colon to introduce/expand, a semicolon
  to join two related independent clauses, commas or parentheses for a short aside.
  The en-dash (–) for numeric/date ranges (`0.6–0.7`, `2021–2026`) is correct and
  unaffected.

### Stakeholder-facing documents (higher bar than internal notes)

- **No internal commentary in the final product** — keep build artifacts out of the
  prose (source filenames, code anchors, run dates, seeds, scratch-table names,
  QC-harness names, "TODO/verify" asides). These belong in the companion
  `provenance.md` or the analysis spec. The distributed document carries the science:
  design, numbers, interpretation, and the caveats that bear on how results should be
  read.
- A reproducibility pointer, if wanted, is a single neutral sentence ("all figures
  derive from a pre-specified, reproducible analysis; full provenance is recorded
  separately"), not an inline dump of paths and parameters.
- `[TODO: ...]` may track open items while drafting; all must be resolved and removed
  before distribution.

### Precision

- Distinguish requirements from recommendations ("must" / "should" / "may").
- Quote regulatory and methodological guidance directly when precision matters, with
  a section/page reference.
- Numbers include units; report variability (SD, SE, 95% CI) with point estimates.

### Abbreviations

**Spell out every abbreviation in full at first use**, with the abbreviation in
parentheses, then use the abbreviation thereafter — e.g., "major depressive disorder
(MDD)", "Montgomery–Åsberg Depression Rating Scale (MADRS)". This applies to each
document independently and to acronyms, initialisms, and instrument names alike.
Common units (mg, kg, mL) and universal abbreviations (e.g., i.e.) are exempt. Once
defined, do not re-expand later in the same document.

### Structure and headings

- **Heading levels.** Use `#` for the document title *and* every top-level section;
  `##` for subsections, `###` below. Do **not** demote top-level sections to `##`
  just because the title is `#` — a single `#` per top-level section produces a clean,
  correctly-nested table of contents. The PDF renderer lifts the first `#` as the
  title and maps remaining top-level headings to numbered sections.
- Headings may be numbered (`# 1. Introduction`) for long formal documents or
  unnumbered for shorter pieces; the renderer auto-numbers either way.

## Section-based editing

Any document more than a few pages long should be edited **one section at a time** —
not primarily for context-window limits (modern windows are large) but to keep the
agent *focused on the task in front of it*. Extracting only the section under
revision produces faster, cheaper, higher-quality edits because the agent isn't
distracted by (or re-deriving) the rest.

**Core pattern — never load the full document.** Instead: (1) generate an outline;
(2) extract only the sections you need; (3) edit in isolation; (4) reassemble only if
you split. Full-document read is for genuinely holistic tasks (finding gaps, checking
consistency, final editorial pass — the Reviewer often needs it, the Writer rarely
does).

## TODO discipline

**The most important rule: do not fill gaps.** If you do not have an authoritative
source or explicit guidance for a claim, insert an annotated `[TODO: ...]` instead of
writing something plausible-sounding. A confident sentence that is slightly wrong is
worse than an explicit "I don't know yet."

**Forms.**

- `[TODO: specific request]` — generic placeholder. *Good:* `[TODO: PI: confirm
  whether we're using the 30-day or 60-day baseline window]`. *Poor:* `[TODO: add
  background]`.
- `[TODO: citation needed: ...]` — a claim lacks a supporting reference; include
  context for the RA to search efficiently.
- `[TODO: verify: ...]` — a claim has a cited source but the source, or the
  claim↔source match, is unverified.
- `[TODO: PI: ...]` — the question requires a PI-level scientific or regulatory
  judgment.

**What this is NOT:** a code-review comment system; a place to stash ideas (use
`pm/issues.md`); or a substitute for the Reviewer (reviewers flag problems *in content
that exists*; TODOs mark *content deliberately left incomplete*).
