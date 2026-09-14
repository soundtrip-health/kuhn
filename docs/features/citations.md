---
title: Citations and references
area: citations
keywords: cite, citation, references, bibliography, bib, PubMed, arXiv, DOI, Crossref, cite key, citation group, citeproc, verify references, Research Assistant
---

# Citations and references

Every project has a reference store in Kuhn's database; `draft/references.bib` is generated from it. You cite with Pandoc syntax (`[@key]`), which the rich editor shows as chips, and the PDF, Word and LaTeX outputs resolve through Pandoc citeproc. The Research Assistant (shown as "Research" in the chat) finds sources and maintains the store. Nobody edits the `.bib` by hand.

## /cite and the cite picker

**What it does.** Searches PubMed from inside the editor and inserts the chosen paper as a citation chip at the caret, adding it to the project bibliography in the same step.

**How to use it.** Type `/` at the start of a line and pick "Cite", or type `/cite`. A panel opens at the caret with the placeholder "Search PubMed… (Esc to cancel)". Type a query; up to 8 candidates appear (title, up to three authors, journal, year) and the status line reads "N results · ↑↓ select, Enter to cite". Choose with the arrow keys and Enter, or click a result. Kuhn verifies the PMID against PubMed, stores the work, regenerates the `.bib`, inserts `[@key]` as a chip and shows the toast "Citation inserted · draft/references.bib updated".

**Prerequisites.** The editor role: a viewer can search but the add is refused, and slash commands are disabled in read-only documents. The backend needs network access to PubMed.

**Gotchas.** The picker searches PubMed only. For arXiv preprints, DOIs from other publishers, or web and government sources, ask the Research Assistant (below). Citing a paper already in the store reuses its key instead of creating a duplicate. Esc or a click outside the panel cancels.

## Citation syntax and citation groups

**What it does.** Kuhn uses Pandoc citation syntax. One bracket holds one citation *group*: one or more `@key` items separated by `;`, each optionally with prefix text, a locator, and a `-` before the `@` to suppress the author name. The rich editor renders the whole group as a single chip and writes the source back byte-for-byte.

**How to use it.** Type or paste the syntax, or let `/cite` insert it.

- `[@lewis2023]` — one work
- `[@lewis2023; @smith2024]` — several works in one group
- `[see @lewis2023, pp. 12-14; -@smith2024]` — prefix, page locator, suppressed author

Keys may contain letters, digits and `_ : . + -`. A bracket with no `@key` in it (for example `[TODO: verify]`) is not a citation and stays plain text.

**Prerequisites.** None.

**Gotchas.** Never backslash-escape the opening bracket (`\[@key]`): Pandoc then reads literal text and the reference drops out of the output. Do not write author–year text by hand; the output style renders it. Hover a chip to confirm what its key resolves to.

## The citation hover card

**What it does.** Hovering a citation chip shows what it cites: the key, up to five authors (then "… et al. (N more)"), the title, and a source line such as "Nature. 2024;12(3):45–67".

**How to use it.** Hover any `@key` in a chip. "Details" expands the abstract and links (`doi:…`, `PubMed …`, "Source"); "Less" collapses them. "Open in references.bib" opens the bibliography in the raw text view and scrolls to the entry. The card closes on Esc, on scroll, or on a click elsewhere.

**Prerequisites.** The key must exist in the reference store or in the project's `.bib` file.

**Gotchas.** An unknown key shows "Not in draft/references.bib. Ask the RA to add it, or cite it again with /cite." The chip still renders, but the reference will be missing from the rendered output.

## The reference store and draft/references.bib

**What it does.** The canonical list of a project's references lives in Kuhn's database: cite key, authors, title, venue, volume/issue/pages, identifiers (DOI, PMID, PMCID, URL) and abstract. `draft/references.bib` is a derived file, rewritten whenever a reference is added, corrected or removed, and again before every render and export.

**How to use it.** You do not maintain the store directly; `/cite` and the Research Assistant's tools do. Read the `.bib` from the Files panel or via "Open in references.bib". Cite keys are the first author's family name plus year (`smith2024`), with `a`, `b`, … appended when that base already names a different work. A key never changes once assigned, so in-text citations survive metadata corrections. Adding a work that is already stored (same DOI or PMID, or the same title, first author and year when neither identifier is known) returns the existing key.

**Prerequisites.** None. A project has no `.bib` until its first reference is added.

**Gotchas.** Do not edit `draft/references.bib` by hand. The file opens with the header "Generated from this project's reference database — do not edit by hand", and edits are overwritten at the next regeneration; agents' file tools refuse to write it for the same reason. If a project has no stored references at all, a hand-written file at `draft/references.bib` is read as-is by the renderer, but it is replaced as soon as the first reference enters the store. The renderer always reads the bibliography at `draft/references.bib`, whatever folder the document is in.

## How the Research Assistant finds and adds sources

**What it does.** The Research Assistant searches the literature and adds references with tools that fetch the full record from the authoritative registry — the agent never types citation metadata. `pubmed_search` searches PubMed; `arxiv_search` searches arXiv; `search_org_knowledge` searches the organization's knowledge library; on Anthropic models it also has web search for guidance documents indexed nowhere else.

**How to use it.** Select "Research" in the chat and ask in plain language: "Find three recent randomized trials of X and add them to the bibliography", or "Add the paper with DOI 10.1000/xyz". The agent reports each key back ("Cite it as [@key]"), the chat logs a line such as "ra added citation [@key]", and the editor reloads the bibliography. The Writer can add PubMed citations itself while drafting, and the PM or Writer can dispatch the Research Assistant as a sub-agent when they need a source. The tools behind this:

- `add_citation` — a PubMed ID; the record is fetched from PubMed.
- `add_reference` — an arXiv id (fetched from arXiv) or a DOI (fetched from Crossref). Only an identifier-less source (a web page, government guidance) may be described manually, and then with an organization as author and a URL.
- `update_reference` — resyncs an existing entry from its registry by cite key (optionally with a corrected PMID, DOI or arXiv id when the stored one points at the wrong work); the key itself never changes. Agents cannot type an author list, title, venue or year into the store — only an identifier-less manual entry accepts typed fields, and never person-name authors.
- `remove_reference` — deletes an entry by cite key (a duplicate, or one that could not be verified).

**Prerequisites.** The editor role to direct agents. The backend needs outbound network access; an organization can store an `ncbi-api-key` secret to raise the PubMed rate limit.

**Gotchas.** The Research Assistant runs on a small model by default, which suits high-volume searching; ask the Advisor or PM for judgement about *which* sources belong. Preprints are flagged as needing a check for a peer-reviewed version. A tool reply of "Already in draft/references.bib as …" is success — the existing key is reused.

## Verifying references

**What it does.** `verify_references` re-fetches each stored entry from its registry — PubMed by PMID, Crossref by DOI, arXiv by id — and compares every field (authors, title, year, DOI, volume, issue, pages, venue). Each entry comes back `verified`, `mismatch` (with the registry's value for each differing field), `not_found`, or `unverifiable` (no identifier; needs a human check).

**How to use it.** Ask the Research Assistant to "verify the references" (optionally naming cite keys), or ask the Reviewer to check claims against evidence — both have the tool. The Research Assistant fixes a mismatch with `update_reference`, which rewrites the entry from the registry record. Every `add_citation`, `add_reference` and `update_reference` result also ends with a verification line for the stored row (checked against the record just fetched, so it costs no extra registry call); a warning there means an existing entry disagrees with its registry. Agents are instructed never to call references "verified" unless this check ran clean.

**Prerequisites.** Network access to the registries. Manually described entries (no PMID, DOI or arXiv id) are always `unverifiable`.

**Gotchas.** Entries are checked one at a time because the registries rate-limit, so a large bibliography takes a while. Verification covers metadata, not whether the paper supports the claim it is cited for — that is a Reviewer question.

## How citations render in PDF, Word and LaTeX

**What it does.** Before every preview render and export, Kuhn regenerates `draft/references.bib` from the store and runs Pandoc with `--citeproc` and that bibliography. Citation groups become formatted citations and a reference list is appended, in Pandoc's default citation style. The same pipeline feeds the PDF preview and the "Word (.docx)", "LaTeX (.tex)" and "PDF (.pdf)" exports.

**How to use it.** Click "Preview PDF" or pick a format from the "Export" menu; nothing else is needed.

**Prerequisites.** The Pandoc and Typst Docker images (see `preview-export.md`).

**Gotchas.** There is no setting to choose a different citation style (CSL) yet. Marp slide decks (`marp: true`) skip citeproc entirely — slides cite informally. A key that is not in the store cannot be resolved in the output; check hover cards for "Not in draft/references.bib" before exporting.
