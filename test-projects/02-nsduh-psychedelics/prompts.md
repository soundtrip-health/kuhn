# Prompts — NSDUH psychedelics test project

Run in order after the data + database prep in [README.md](README.md) (the
`nsduh-db` org secret must exist). The core loop under test: **plan (writer) →
implement against the database in the sandbox (analyst) → narrate from
artifacts (writer) → verify (reviewer)** — numbers may only enter prose from
generated tables/figures.

## §1 Setup wizard

| Field | Value |
|---|---|
| Project type | Manuscript |
| Title | `Psychedelic drug use in the United States: a descriptive analysis of the 2023 NSDUH` |
| Research question | `What are the prevalence and demographic patterns of psychedelic drug use — broadly defined (LSD, psilocybin, peyote/mescaline, DMT-class tryptamines, MDMA/ecstasy, ketamine, PCP, salvia) — among US persons aged 12+, and how does use relate to psychological distress? Descriptive analysis of the 2023 NSDUH public-use file.` |
| Deliverables | `Manuscript with a descriptive analysis of the results, including tables and figures` |
| Timeline | `Analysis and full draft within this test session` |
| Uploads | `db-guide.md`, `data-prep/variables.md`, `data-prep/build/extract-manifest.md` |
| Final step | **Launch research + skeleton now** |

**Check:** seeding completes; the RA's bibliography is real psychedelic-
epidemiology literature; the skeleton has Methods/Results placeholders.

## §2 PM — data briefing

> The dataset for this project lives in the org Postgres warehouse: table nsduh.nsduh_2023 (2023 NSDUH public-use file). seed_docs/db-guide.md is the connection contract (org secret nsduh-db via run_script), and seed_docs/variables.md + seed_docs/extract-manifest.md document variables, weights, and response codes. Brief the team: record in pm/ how the data must be accessed and used (secret-injected connection, survey weights mandatory, recode 91/93/94/97/98 response codes, persons 12+, never print credentials), and update the status file.

**Check:** PM reads the uploaded docs and writes an accurate data brief —
secret name, table name, and weight variable all correct; no invented
variables; the DSN value nowhere (the PM never sees it).

## §3 Writer — analysis plan (spec before code)

> Write draft/analysis-plan.md: a numbered spec for a descriptive analysis the analyst can implement directly. Include: Table 1 — weighted lifetime and past-year prevalence of each psychedelic substance and any-hallucinogen, persons 12+, with 95% CIs; Table 2 — demographic profile (age, sex, race/ethnicity, education, income) of past-year psychedelic users vs non-users, weighted column %; Figure 1 — past-year use by age group, per substance; Figure 2 — past-month serious psychological distress (the SPDPSTMON recode) among past-year psychedelic users vs non-users, by substance. Specify for each: the source (table nsduh.nsduh_2023 via the nsduh-db connection), variables from seed_docs/extract-manifest.md, weighting, and output paths under draft/tables/ and draft/figures/.

**Check:** the plan references only variables the manifest lists; outputs and
weighting are specified per item.

## §4 Analyst — implement against the database

> Implement draft/analysis-plan.md. The data is in Postgres: table nsduh.nsduh_2023, reached exactly as seed_docs/db-guide.md describes — list_secrets to confirm the handle, then run_script with secrets: ["nsduh-db"] and connect via the KUHN_SECRET_NSDUH_DB env var. Before trusting any count, spot-check the response codes with GROUP BY queries (the 91/93/94/97/98 codes must be handled explicitly). You have SELECT on nsduh.*, CREATE on the sandbox schema, and TEMP — stage intermediate/cohort tables in sandbox.* or temp tables (never expect writes to nsduh to succeed) and drop your sandbox tables when done. Write your R under analyst/, and deliver: tables as CSV under draft/tables/, figures as PNG under draft/figures/ with plotted data cached alongside, and a provenance.md in each output directory naming the driver script, source table, and weighting. Use the survey design (analwt2_c weight, vestr_c strata, verep PSU) for estimates and CIs. Run a plausibility check against the halluc* aggregate recodes and flag anything surprising before finishing. Never print the DSN or any KUHN_SECRET_* value.

**Check:** every run goes through `run_script` **with `secrets`** (script-run
rows recorded; a nonzero exit is followed by a visible fix-and-rerun, not
silent retyping); the credential value appears nowhere in chat, scripts, or
outputs; outputs are copied from `analyst/output/run-<id>/`; `provenance.md`
names the driver script, `nsduh.nsduh_2023`, and `analwt2_c`; any staged
intermediates live in `sandbox.*`/temp tables and are cleaned up; prevalence
sanity band per [README.md](README.md).

## §5 RA — grounding literature

> Add citations for: (1) the most recent official NSDUH annual-report release; (2) at least two peer-reviewed epidemiology papers on hallucinogen/psychedelic use trends in the US; (3) one methods reference for analyzing complex-survey data. Update research/literature-summary.md accordingly.

**Check:** real, resolvable entries; the NSDUH data-file citation itself
matches the SAMHSA release.

## §6 Writer — Methods + Results from artifacts

> Write the Methods and Results sections of draft/main.md. Methods: data source, broad psychedelic definition, weighting/design, recoding, and the limitation that this is a cross-sectional descriptive analysis of public-use data. Results: narrate Tables 1–2 and Figures 1–2, referencing them as tables/figures and embedding the figure images. Every number must come from draft/tables/ or the cached figure data — cite nothing from memory. Use [TODO] markers where an estimate you want is not in the artifacts.

**Check:** arrives as pending suggestions; spot-check 5 numbers in the prose
against the CSVs — all must match; figures embedded with markdown image syntax.

## §7 Reviewer — number audit

> Audit draft/main.md against the analysis artifacts: verify every number, percentage, and CI in Methods/Results appears in draft/tables/ or the cached figure data; verify claims of difference are supported (non-overlapping CIs or an explicit caveat); check the psychedelic definition in Methods matches what Table 1 actually contains. Write findings to research/reviews/number-audit.md.

**Check:** the audit is line-anchored; any mismatch it finds is real (spot-check
one); reviewer does not edit the draft.

## §8 Render

Open **Preview** → **Render**, then export **.docx**.

**Check:** PDF renders with tables, embedded figures, citations, bibliography;
figures are legible; docx opens with images intact.
