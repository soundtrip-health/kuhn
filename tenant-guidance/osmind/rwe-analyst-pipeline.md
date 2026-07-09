# Osmind RWE analyst pipeline (Ketamine vs. Esketamine)

> ⚑ **Osmind-specific.** This documents the analyst pipeline for the Osmind RWE
> study (nrx-rwe-protocol). It names Osmind's PostgreSQL warehouse
> (`analytics_omop`, `nrx_temp`, `_`-prefixed columns) and project-local pipeline
> code. It was extracted from the generic analyst agent prompt so the prompt stays
> tenant-neutral. Pair with [`rwd-column-catalog.md`](rwd-column-catalog.md) and
> [`ketamine-esketamine-analysis-conventions.md`](ketamine-esketamine-analysis-conventions.md).
>
> **Note on Kuhn's data layer:** this pipeline predates Kuhn's SQLite migration and
> still describes a PostgreSQL data warehouse. When Osmind is onboarded as a proper
> tenant, reconcile the warehouse connection details with the deployment.

## Architecture

- **`analyst/src/postgres_client.py`** — Generic PostgreSQL client (psycopg3) with auto-reconnect, DataFrame insert via COPY, and schema introspection. Connection URL from `POSTGRES_URL` or `DATABASE_URL` env var (loaded from `.env`).
- **`analyst/src/queries.py`** — `ASCPQueries` class that orchestrates the full cohort build as a sequence of temp tables under `nrx_temp`. Each `create_*` method builds one temp table and returns a summary DataFrame. Methods must be called in dependency order.
- **`analyst/src/utils.py`** — Constants (antidepressant drug lists by class), Plotly figure helpers, Census API income lookup, demographic cleaning, CONSORT diagram rendering (Mermaid CLI), and LaTeX table generation.
- **`analyst/src/drug_lookup.py`** — Antidepressant classification via RxNav RxClass API with caching and rate limiting.
- **`analyst/src/power_analysis.R`** — Propensity score IPTW and power calculation (run after Python pipeline).
- **`analyst/explore/`** — Diagnostic and investigative scripts.

## Environment Setup

Requires Python with: `psycopg[binary]`, `pandas`, `numpy`, `plotly`, `requests`, `python-dotenv`.

```bash
source .venv/bin/activate
pip install "psycopg[binary]" pandas numpy plotly requests python-dotenv
```

Environment variables needed in `analyst/.env`:
- `POSTGRES_URL` or `DATABASE_URL` — PostgreSQL connection string
- `CENSUS_API_KEY` — for ZIP-code median income lookup (optional)

For CONSORT diagram rendering: `npm install -g @mermaid-js/mermaid-cli` (provides `mmdc`).

## Key Conventions

- **Source schema:** All EHR tables live in `analytics_omop` (e.g., `analytics_omop.procedure_occurrence`). Join on `person_id`.
- **Temp schema:** Intermediate analysis tables go in `nrx_temp`. Methods create indexes after table creation.
- **OMOP column naming:** Osmind-specific columns are prefixed with `_` (e.g., `_procedure_concept_name`, `_drug_generic_concept_name`).
- **Drug classification:** Uses `DrugLookup` from `drug_lookup.py` for bulk antidepressant classification via RxNav API.
- **Output artifacts:** Figures go to `draft/figures/`, tables to `draft/tables/`.

## Table Dependency Order

When running the full pipeline, temp tables must be created in this order:
1. `create_first_exposure_table()` — builds `nrx_temp.first_exposure`
2. `create_drug_exposure_table()` — builds `nrx_temp.drug_exposure` (needs `first_exposure`)
3. `create_outcome_table(measures)` — builds `nrx_temp.outcome` (needs `first_exposure`)
4. `create_zip_income_table()` — builds `nrx_temp.zip_income_acs5`
5. `create_participants_table()` — builds `nrx_temp.participants` (needs `outcome` + `zip_income_acs5`)
6. `get_sample_for_analysis()` — builds `nrx_temp.analysis_sample_final` (needs `outcome` + `participants`)

## Key Commands

```bash
# Run full analysis pipeline
python analyst/src/main.py

# Run power analysis (after Python pipeline completes)
Rscript analyst/src/power_analysis.R
```
