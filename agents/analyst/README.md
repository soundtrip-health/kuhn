# Analyst Agent Workspace

This directory is the **analyst agent** workspace for the Kuhn scientific writing framework. The analyst receives analysis specifications from the writer and produces quantitative outputs — tables, figures, and markdown reports in `draft/`.

The analyst adapts to the project type: biostatistician for clinical protocols, data scientist for manuscripts, quantitative analyst for grants. The code below documents the current RWE analysis pipeline; new projects will have their own analysis code. See the [top-level README](../README.md) for the full multi-agent architecture.

## Current Project: RWE Feasibility and Power Analysis

The current pipeline produces cohort enumeration, propensity score feasibility, assessment density, subgroup analyses, dosing descriptives, and power estimates.

## What It Produces

Running the full pipeline (`src/main.py`) generates:

| Analysis | Output Files | Spec Section |
|---|---|---|
| Cohort enumeration (8-step sequential filtering) | `cohort_enumeration.md` | 1 |
| Propensity score feasibility (completeness, distributions, SMD) | `propensity_score_feasibility.md` | 2 |
| Assessment density (PHQ-9 timing and counts) | `assessment_density_*.csv` | 3 |
| Subgroup cell sizes (flags <30 patients) | `subgroup_cell_sizes.csv` | 4 |
| Supplementary tables (attrition, dual exposure) | `supplement_*.csv` | 5 |
| Dosing descriptives (sessions, doses, frequency) | `dosing_*.csv` | 6 |
| Power analysis inputs (variance, trajectories) | `power_*.csv` | 8 |
| Bipolar exploratory cohort | `bipolar_*.csv` | 9 |

All tables go to `./draft/tables/`. Figures go to `./draft/figures/`. Narrative markdown reports go to `./draft/`.

After the Python pipeline completes, `src/power_analysis.R` reads the CSV outputs and computes IPTW effective sample sizes and non-inferiority power estimates.

See `OUTPUT_GUIDE.md` for a detailed mapping of each output CSV to its corresponding spec section and how to extract values for the protocol draft.

## Architecture

```
feasibility/
├── CLAUDE.md                    # Analyst agent instructions & data conventions
├── README.md                    # This file
├── OUTPUT_GUIDE.md              # Maps each output CSV to spec sections
├── feasibility_analysis_spec.md # Analysis specification (from the writer agent)
├── src/                         # Analysis source code
│   ├── main.py                  # Pipeline orchestrator — runs all analyses sequentially
│   ├── queries.py               # ASCPQueries class (~2,000 lines) — cohort build + all analyses
│   ├── postgres_client.py       # PostgreSQL client (psycopg3) with auto-reconnect
│   ├── utils.py                 # Constants, plotting, Census API, LaTeX table generation
│   ├── drug_lookup.py           # Antidepressant classification via RxNav API
│   └── power_analysis.R         # Propensity score IPTW & power calculation
├── explore/                     # Diagnostic and investigative scripts
│   └── investigate_trd_step6.py # Debugging high dropout at TRD/PHQ-9 steps
└── draft/                       # Output directory (created at runtime)
    ├── tables/                  # CSV and markdown tables
    └── figures/                 # Plotly PNG figures
```

### Key Components

**`src/queries.py` (ASCPQueries)** is the core engine. It builds temporary tables in the `nrx_temp` schema in dependency order, then runs analysis methods that query those tables. Each method returns DataFrames and writes output files.

**`src/postgres_client.py`** provides a generic PostgreSQL client with connection pooling, auto-reconnect, DataFrame bulk insert via COPY, and schema introspection.

**`src/utils.py`** contains antidepressant drug lists by class (SSRI, SNRI, etc.), Plotly figure helpers, Census API ZIP-code income lookup, and LaTeX table generation.

**`src/drug_lookup.py`** classifies drugs as antidepressants via the RxNav RxClass API, with caching and rate limiting for bulk lookups. Used to count distinct prior antidepressant exposures for TRD status ascertainment.

**`src/power_analysis.R`** fits a logistic propensity score model, computes stabilized IPTW weights (truncated at 1st/99th percentiles), calculates effective sample sizes per arm, and estimates power for a non-inferiority LME test with a 0.6 PHQ-9 point margin.

## Table Dependency Order

Temporary tables must be created in this sequence:

1. `create_first_exposure_table()` -> `nrx_temp.first_exposure`
2. `create_drug_exposure_table()` -> `nrx_temp.drug_exposure`
3. `create_outcome_table(measures)` -> `nrx_temp.outcome`
4. `create_zip_income_table()` -> `nrx_temp.zip_income_acs5`
5. `create_participants_table()` -> `nrx_temp.participants`
6. `get_sample_for_analysis()` -> `nrx_temp.analysis_sample_final`

## Data Conventions

- **Source schema:** `analytics_omop.*` (Osmind EHR in OMOP format)
- **Temp schema:** `nrx_temp.*` (intermediate analysis tables)
- **OMOP columns:** Osmind-specific columns prefixed with `_` (e.g., `_procedure_concept_name`)
- **Treatment assignment:** First-ever IV ketamine or IN esketamine administration determines arm; dual-exposed patients excluded
- **Study period:** January 1, 2021 -- March 31, 2026

## Prerequisites

**Python packages:**
```bash
uv pip install "psycopg[binary]" pandas numpy plotly requests python-dotenv
```

**R packages** (for power analysis):
```r
install.packages(c("dplyr", "readr"))
```

**System tools:**
```bash
npm install -g @mermaid-js/mermaid-cli  # for CONSORT diagram rendering
```

**Environment variables** (in `.env`):
```
POSTGRES_URL=postgresql://user:pass@host:port/dbname
CENSUS_API_KEY=your_key_here  # optional, for ZIP-code income lookup
```

## Running the Pipeline

```bash
# Full analysis pipeline
python src/main.py

# Power analysis (after Python pipeline completes)
Rscript src/power_analysis.R

# Diagnostic: investigate TRD step dropout
python explore/investigate_trd_step6.py
```

## The Handoff

The analyst receives `feasibility_analysis_spec.md` from the writer agent. This spec defines:
- The 8-step cohort enumeration criteria
- Propensity score covariates and completeness thresholds
- Assessment windows and alternative instruments to check
- Subgroup definitions and minimum cell size flags
- Dosing descriptive breakdowns
- Power analysis parameters (NI margin, variance components)

Results flow back as markdown reports and CSV tables in `./draft/`, which the writer agent reads to revise the protocol with empirical grounding. The human PI reviews each handoff for plausibility.
