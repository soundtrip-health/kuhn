# Datasheets for Datasets (Gebru et al.)

> **Kuhn knowledge card.** Canonical source: https://arxiv.org/abs/1803.09010 (arXiv; journal version in Communications of the ACM, 2021). Source access/license: free, open-access preprint (arXiv, with authors' distribution license). This card is a Kuhn-authored summary — cite and consult the canonical source for authoritative text.

## Scope

"Datasheets for Datasets" proposes that every dataset used to train or evaluate machine-learning models be accompanied by a **datasheet**: a structured document, modeled on the datasheets that accompany electronic components, answering a fixed set of questions about how the dataset came to be and how it may responsibly be used. The framework applies to any dataset — collected, scraped, licensed, synthetic, or derived.

It serves two audiences: **creators**, whom the questions force to reflect on collection and its consequences while decisions can still be changed, and **consumers**, who need the answers to judge fitness for their task, avoid misuse, and report their work accurately. It is the dataset-side companion to Model Cards for Model Reporting, and the ancestor of dataset documentation now expected by ML venues (e.g., the NeurIPS Datasets & Benchmarks track) and data hubs.

## Key requirements

The datasheet is organized as questions in seven categories keyed to the dataset lifecycle, paraphrased:

- **Motivation.** Why the dataset was created; for what task or gap; who created it (team, organization) and who funded it. Answers establish purpose, which anchors every later fitness-for-use judgment.
- **Composition.** What the instances are (documents, images, people, interactions) and how many; whether the dataset samples a larger population and, if so, how representative the sample is.
  - What each instance contains, whether anything is missing, and what the labels/targets are.
  - Known errors, noise, and redundancies; whether the dataset is self-contained or links to external resources (and what happens when those change).
  - Whether it contains confidential material or content that may be offensive or distressing.
  - For data about people: whether subpopulations are identified, whether individuals are identifiable, and whether any data is sensitive (health, beliefs, biometrics, precise location).
- **Collection process.** How the data was acquired (direct observation, human annotation, scraping, instruments) and how it was validated; the sampling strategy; who collected it and how they were compensated; the time frame of collection; whether ethical review (e.g., IRB) occurred.
  - For data about people: whether it came from them directly or via third parties, whether they were notified and consented, and whether consent can be revoked.
- **Preprocessing / cleaning / labeling.** What was done to the raw data (tokenization, filtering, deduplication, bucketing, label aggregation) and with what software.
  - Whether the raw data is preserved and accessible alongside the processed release.
- **Uses.** What the dataset has already been used for (ideally with a repository of works using it) and what other tasks are plausible.
  - Anything about composition or collection that could make some uses unfair, harmful, or simply invalid — and tasks the dataset should *not* be used for.
- **Distribution.** How and where it is available (download, DOI, API) and when; under what license and terms of use.
  - Any third-party IP restrictions, export controls, or other regulatory constraints.
- **Maintenance.** Who hosts and maintains it and how to contact them; whether it will be updated (corrections, additions, deletions) and how consumers learn of updates.
  - Retention limits for data about people; whether old versions remain available; and how others can contribute or extend the dataset.

The paper is deliberately a set of questions rather than a checklist to tick: answers should be prose and honest about unknowns.

Depth should be proportional to the dataset's risk — datasets about people warrant the fullest treatment.

## How to write one / apply when writing

- Draft the datasheet **during** collection, not after release: the motivation, sampling, consent, and compensation questions are design decisions, and answering them late usually means answering them badly.
- Use the seven categories as document headings and answer every applicable question explicitly, including with "unknown" or "not applicable — because…" where true; unanswered questions are indistinguishable from concealment.
- For papers that *introduce* a dataset: include the datasheet as an appendix or supplementary file, cite it from the main text, and mirror its key facts (size, source, license, consent status, known gaps) in the dataset section of the paper. Venue checklists (NeurIPS) explicitly ask for this documentation plus license and PII/consent statements.
- For papers that *use* an existing dataset: consult its datasheet (or note its absence), and report in your methods the version used, license compliance, known composition biases relevant to your task, and any preprocessing you added.
- Keep the datasheet versioned with the dataset; a new release (new instances, relabeling, takedowns) gets an updated datasheet with a change note.
- Write the "uses" answers as concretely as the out-of-scope section of a model card: name task types that the sampling frame, consent basis, or label semantics cannot support.
- Record annotator instructions and compensation as part of the collection answers — venue checklists (e.g., NeurIPS) ask for both explicitly.

## Common pitfalls

- Post-hoc datasheets that reverse-engineer answers ("presumably scraped from public web") instead of recording what actually happened.
- Silence on consent, notification, and identifiability for data about people — the questions most likely to be asked by reviewers and ethics boards.
- Describing the ideal sampling plan rather than the achieved sample, and omitting known skews, duplicates, and label-noise estimates.
- Missing license/terms, or a license incompatible with the redistribution the paper implies.
- No maintenance answer: no contact, no update policy, no versioning — so downstream users cannot learn of corrections or takedowns.
- Documenting only the final release while omitting what filtering removed and why — the removed material shapes what remains.
- Treating synthetic or derived datasets as exempt; provenance of the source data and the generation process still need documenting.

## Canonical links

- Datasheets for Datasets (arXiv, canonical): https://arxiv.org/abs/1803.09010
- Communications of the ACM version (DOI): https://dl.acm.org/doi/10.1145/3458723
- Companion framework — Model Cards for Model Reporting: https://arxiv.org/abs/1810.03993
