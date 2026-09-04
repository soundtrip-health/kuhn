# Test project 2 — NSDUH psychedelics (data-science manuscript)

The data-analysis end-to-end test: a **descriptive epidemiology manuscript on
psychedelic drug use in the United States** — psychedelics broadly defined
(LSD, psilocybin, peyote/mescaline, DMT-class tryptamines, MDMA/ecstasy,
ketamine, PCP, salvia) — built on the **2023 National Survey on Drug Use and
Health (NSDUH) public-use file** (SAMHSA; US-government work, public domain,
56,705 respondents aged 12+) served from a **real Postgres database** the
analyst queries with **credentials from the org secrets store**.

This project is deliberately two things at once:

1. **A demo/test of Kuhn's data-access capabilities** — secrets store, secret
   injection into sandboxed runs, the internal data network, SQL + weighted
   analysis, artifact provenance.
2. **An admin's guide for real deployments**: the scripts here are the
   worked example of wiring a Kuhn instance to a private data warehouse with
   fine-grained permissions. See
   [Using this as a deployment guide](#using-this-as-a-deployment-guide-real-data-warehouses).

**What it exercises** (beyond project 1):

- the **org secrets manager** (Org admin → Secrets): an editor stores a DB
  credential; values are write-only and never reach the model
- the analyst's **`run_script` with `secrets`**: the DSN is injected into the
  sandbox as `KUHN_SECRET_NSDUH_DB`, and the run joins the *internal* docker
  data network (`kuhn-data`) — database access with the no-internet invariant
  intact
- **real SQL against Postgres** with warehouse-style access control: the
  `kuhn_analyst` role is **SELECT-only on the data schema (`nsduh`)** but may
  **create tables in a scratch schema (`sandbox`)** and temp tables — the
  everyday pattern of staging intermediate/cohort tables without being able
  to touch source data
- the analyst's RWD QC discipline (spot-check predicates before trusting
  counts), survey-weighted statistics, and generated **tables + figures**
  with provenance
- a Results/Methods narrative that must trace to those artifacts

## Prerequisites

- Everything from [project 1](../01-kuhn-manuscript/README.md), **plus** the
  analyst R image rebuilt with the DB + survey packages:
  `docker build -t kuhn/r-analysis:latest docker/r-analysis`
  (needs `survey`/`srvyr` and `DBI`/`RPostgres` — both in the current
  Dockerfile; rebuild if your image predates them).

## Setup

1. **Data + database** (one-time; ~40 MB download from SAMHSA, no host R or
   psql needed — everything runs in Docker):

   ```bash
   cd data-prep
   ./fetch-nsduh.sh     # download the 2023 PUF R bundle → build/
   ./make-extract.sh    # trim to the analysis extract (117 vars × 56,705 rows)
   ./setup-db.sh        # internal net kuhn-data + postgres + read-only analyst role
   ./load-nsduh.sh      # load nsduh.nsduh_2023, verify counts & access control
   ```

   `load-nsduh.sh` ends by proving the permission model live: the analyst role
   can SELECT from `nsduh`, cannot write to it, and CAN create (and drop)
   tables in `sandbox` and temp tables. It also prints the weighted past-year
   hallucinogen prevalence (expect ≈ 3.07%).
   The DB is reachable **only** from containers on the internal `kuhn-data`
   network — not from the host, not from the internet.

2. **Backend**: make sure the backend's `SANDBOX_SECRETS_NETWORK` is unset (it
   defaults to `kuhn-data`) or points at the network `setup-db.sh` created,
   then start/restart it.

3. **Create the org + project** (suggested: org `E2E-Org1`, project
   `NSDUH Psychedelics`, type **Manuscript**).

4. **Store the credential** — as an org **editor or owner**: org menu →
   Org admin → **Secrets** → add secret

   - name: `nsduh-db`
   - value: the DSN in `data-prep/build/analyst-dsn.txt`
   - description: `NSDUH 2023 warehouse — read-only analyst role`

   The value disappears into the store (write-only); the UI can only replace
   or delete it from here on.

5. **Run the setup wizard** with the answers in [`prompts.md`](prompts.md) §1,
   uploading at the uploads step: `db-guide.md`, `data-prep/variables.md`, and
   `data-prep/build/extract-manifest.md`. (No data file is uploaded — the
   data lives in the database; that's the point.)

6. Work through [`prompts.md`](prompts.md) §2–§8 in order.

Reset: `data-prep/teardown-db.sh` removes the DB container + volume; delete
the secret in Org admin → Secrets.

## Pass criteria

- [ ] Secrets UI: creating `nsduh-db` succeeds for an editor; the value is never displayed again anywhere (list shows metadata only); viewers cannot create/delete
- [ ] Seeding completes; bibliography seeds with real epidemiology/psychedelic-research papers
- [ ] `list_secrets` shows the analyst `nsduh-db` (name + env var, no value)
- [ ] Writer produces `draft/analysis-plan.md` specifying tables/figures before any analysis runs
- [ ] Analyst queries Postgres **through `run_script` with `secrets: ["nsduh-db"]`** — script-run rows recorded; connection read from `KUHN_SECRET_NSDUH_DB`; no credential ever appears in chat, the draft, or committed scripts
- [ ] A run **without** `secrets` cannot reach the DB (no network); a run with them cannot reach the internet (internal network) — the analyst's scripts must not try
- [ ] If the analyst stages intermediates, they land in `sandbox.*` (or temp tables) and are dropped when done; any attempted write to `nsduh.*` fails and the analyst treats that as by-design, not an outage
- [ ] Tables land in `draft/tables/` as CSV with a sibling `provenance.md` (driver script, SQL source table, weight variable, generation date)
- [ ] Figures land in `draft/figures/` with their plotted data cached alongside
- [ ] Estimates are **survey-weighted** (`analwt2_c`; design-based SEs via `survey`/`srvyr` with `vestr_c` × `verep`) or the fallback limitation is stated in provenance
- [ ] Sanity band: weighted past-year hallucinogen prevalence (12+) ≈ 3% (the loader prints the exact value); lifetime in the mid-teens — cross-check against SAMHSA's [2023 NSDUH detailed tables](https://www.samhsa.gov/data/report/2023-nsduh-detailed-tables)
- [ ] Every number in the Results prose appears in a table/figure artifact (reviewer step verifies)
- [ ] Final render: PDF with tables, embedded figures, formatted citations

## Using this as a deployment guide (real data warehouses)

Everything above is the template for granting a production Kuhn instance
**fine-grained access to a private warehouse**. The moving parts, in order:

1. **A dedicated, least-privilege DB role for agent access.** Never a
   superuser, owner, or a person's account. The grant pattern from
   `setup-db.sh`, generalized:

   ```sql
   CREATE ROLE kuhn_analyst LOGIN PASSWORD '...';
   REVOKE ALL ON SCHEMA public FROM PUBLIC;
   -- read-only on each data schema you expose:
   GRANT USAGE ON SCHEMA <data_schema> TO kuhn_analyst;
   GRANT SELECT ON ALL TABLES IN SCHEMA <data_schema> TO kuhn_analyst;
   ALTER DEFAULT PRIVILEGES IN SCHEMA <data_schema> GRANT SELECT ON TABLES TO kuhn_analyst;
   -- a scratch schema for intermediate/cohort tables (analysts own what they create):
   CREATE SCHEMA sandbox;
   GRANT USAGE, CREATE ON SCHEMA sandbox TO kuhn_analyst;
   GRANT TEMPORARY ON DATABASE <db> TO kuhn_analyst;
   ```

   Expose only the schemas agents should see; PII-bearing columns are better
   handled with views in a dedicated schema and SELECT granted on the views
   only. Consider `ALTER ROLE kuhn_analyst SET statement_timeout = '5min'`
   as a runaway-query guard. One role per org keeps blast radii separate.

2. **Network reachability from the sandbox, without internet.** Sandboxed
   script runs that request secrets join the docker network named by
   `SANDBOX_SECRETS_NETWORK` (default `kuhn-data`). For a DB running as a
   container, attach it to that internal network (as here). For an external
   warehouse, the network must route to it — e.g. a bridge network plus
   firewall egress rules that allow **only** the warehouse host:port. The
   fixture's `--internal` network is the strictest version of this; whatever
   you build, verify the "no internet" check the way `load-nsduh.sh` and the
   pass criteria do.

3. **The credential goes into the org secrets store** (Org admin → Secrets),
   as a DSN (`postgresql://role:password@host:port/db`). Values are write-only
   and AES-encrypted at rest (`KUHN_SECRETS_KEY` — set a dedicated key in
   production and keep it out of DB backups); agents reference the secret by
   name and only sandboxed runs ever see the value, as an env var. Rotate by
   re-saving the name with a new password after `ALTER ROLE ... PASSWORD`.

4. **A data brief in the project** (this project's `db-guide.md`): connection
   contract, schema/permission table, response-code caveats, staging rules.
   Agents work dramatically better against a documented warehouse; this file
   is the piece admins should adapt per project or per org knowledge base.

See also `docs/deployment.md` (backend configuration) and
`docs/security/threat-model.md` (B16 — sandbox boundary and the accepted
residual risks) in the repository.

## Data source & citation

Substance Abuse and Mental Health Services Administration. (2024). *National
Survey on Drug Use and Health 2023 (NSDUH-2023-DS0001) public use file.*
https://www.samhsa.gov/data/data-we-collect/nsduh-national-survey-drug-use-and-health/datafiles/2023
— codebook and data users' guide linked from the same page. Public-use data;
respondents are de-identified. Do not attempt re-identification.
