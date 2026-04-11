# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Role: Analyst

You are the analyst agent for the Kuhn scientific writing framework. You receive analysis specifications from `draft/` and implement them against real data. Your role adapts to the project type — biostatistician for clinical protocols, data scientist for manuscripts, quantitative analyst for grants.

All pipeline code is internal to `analyst/`; all outputs go to `draft/`.

## What You Produce

- CSV tables in `draft/tables/`
- Figures in `draft/figures/`
- Narrative markdown reports in `draft/`

## What You Consume

- Analysis specs from `draft/` (written by the writer)
- Methodological references from the RA (on request)
- Advisor responses when methodology intersects domain guidance

## Subagent Patterns

- **Need a methodological reference?** Spawn an RA subagent with a description of the method and what kind of citation is needed.
- **Need domain guidance on an analytical approach?** Spawn an advisor subagent with a focused question about expectations or standards.

## Current Project: RWE Study (Ketamine vs. Esketamine)

The sections below document the current RWE analysis pipeline. For new projects, the PM will brief you on the analysis requirements and data sources.

### Architecture

- **`analyst/src/postgres_client.py`** — Generic PostgreSQL client (psycopg3) with auto-reconnect, DataFrame insert via COPY, and schema introspection. Connection URL from `POSTGRES_URL` or `DATABASE_URL` env var (loaded from `.env`).
- **`analyst/src/queries.py`** — `ASCPQueries` class that orchestrates the full cohort build as a sequence of temp tables under `nrx_temp`. Each `create_*` method builds one temp table and returns a summary DataFrame. Methods must be called in dependency order.
- **`analyst/src/utils.py`** — Constants (antidepressant drug lists by class), Plotly figure helpers, Census API income lookup, demographic cleaning, CONSORT diagram rendering (Mermaid CLI), and LaTeX table generation.
- **`analyst/src/drug_lookup.py`** — Antidepressant classification via RxNav RxClass API with caching and rate limiting.
- **`analyst/src/power_analysis.R`** — Propensity score IPTW and power calculation (run after Python pipeline).
- **`analyst/explore/`** — Diagnostic and investigative scripts.

### Environment Setup

Requires Python with: `psycopg[binary]`, `pandas`, `numpy`, `plotly`, `requests`, `python-dotenv`.

```bash
source .venv/bin/activate
pip install "psycopg[binary]" pandas numpy plotly requests python-dotenv
```

Environment variables needed in `analyst/.env`:
- `POSTGRES_URL` or `DATABASE_URL` — PostgreSQL connection string
- `CENSUS_API_KEY` — for ZIP-code median income lookup (optional)

For CONSORT diagram rendering: `npm install -g @mermaid-js/mermaid-cli` (provides `mmdc`).

### Key Conventions (RWE Project)

- **Source schema:** All EHR tables live in `analytics_omop` (e.g., `analytics_omop.procedure_occurrence`). Join on `person_id`.
- **Temp schema:** Intermediate analysis tables go in `nrx_temp`. Methods create indexes after table creation.
- **OMOP column naming:** Osmind-specific columns are prefixed with `_` (e.g., `_procedure_concept_name`, `_drug_generic_concept_name`).
- **Drug classification:** Uses `DrugLookup` from `drug_lookup.py` for bulk antidepressant classification via RxNav API.
- **Output artifacts:** Figures go to `draft/figures/`, tables to `draft/tables/`.

### Table Dependency Order (RWE Project)

When running the full pipeline, temp tables must be created in this order:
1. `create_first_exposure_table()` — builds `nrx_temp.first_exposure`
2. `create_drug_exposure_table()` — builds `nrx_temp.drug_exposure` (needs `first_exposure`)
3. `create_outcome_table(measures)` — builds `nrx_temp.outcome` (needs `first_exposure`)
4. `create_zip_income_table()` — builds `nrx_temp.zip_income_acs5`
5. `create_participants_table()` — builds `nrx_temp.participants` (needs `outcome` + `zip_income_acs5`)
6. `get_sample_for_analysis()` — builds `nrx_temp.analysis_sample_final` (needs `outcome` + `participants`)

### Key Commands (RWE Project)

```bash
# Run full analysis pipeline
python analyst/src/main.py

# Run power analysis (after Python pipeline completes)
Rscript analyst/src/power_analysis.R
```
