# NSDUH 2023 database guide (project data brief)

This project's dataset lives in the org's Postgres warehouse, **not** in the
project tree. This file is the connection + usage contract for the analyst.

## Connection

- Org secret: **`nsduh-db`** — a read-only Postgres DSN. Request it per run:
  `run_script` with `secrets: ["nsduh-db"]`, which injects it as the
  environment variable **`KUHN_SECRET_NSDUH_DB`** and attaches the run to the
  internal data network. Without that parameter the sandbox has no network and
  the DB is unreachable (by design).
- In R (the sandbox image ships `DBI` + `RPostgres`). Note RPostgres does
  **not** expand a URI passed as `dbname` — parse the DSN first (copy this
  helper verbatim):

  ```r
  nsduh_connect <- function() {
    uri <- Sys.getenv("KUHN_SECRET_NSDUH_DB")
    m <- regmatches(uri, regexec("^postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):?([0-9]*)/(.+)$", uri))[[1]]
    stopifnot(length(m) == 6)
    DBI::dbConnect(RPostgres::Postgres(), user = m[2], password = m[3], host = m[4],
                   port = if (m[5] == "") 5432L else as.integer(m[5]), dbname = m[6])
  }
  con <- nsduh_connect()
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  ```

- Never print the DSN (or any `KUHN_SECRET_*` value) to stdout/stderr, files,
  or chat. The credential is least-privilege but it is still a credential.

## Permissions

The `kuhn_analyst` role has exactly:

| Schema | Rights | Use it for |
|---|---|---|
| `nsduh` | `SELECT` only | the immutable source data |
| `sandbox` | `USAGE` + `CREATE` (you own what you create) | intermediate/cohort/staging tables |
| (database) | `TEMPORARY` | session-local `CREATE TEMP TABLE` |

Stage heavy intermediates as `sandbox.<project>_<name>` (or temp tables for
single-session work), and **drop your sandbox tables when the analysis is
done** — the scratch schema is shared. Writes to `nsduh` (or `public`) will be
refused; that is by design, not an outage.

## Schema

One table: **`nsduh.nsduh_2023`** — one row per 2023 NSDUH respondent
(56,705 rows, 117 columns; **column names are lowercase** in Postgres, e.g.
`analwt2_c`, `hallucyr`, `ecstmollly` — no: `ecstmolly`; check
`extract-manifest.md` for the authoritative list, `variables.md` for meanings
and response codes).

Key columns:

- design: `analwt2_c` (person weight), `vestr_c` (stratum), `verep` (PSU) —
  every reported estimate must be weighted
- substances: raw items (`lsd`, `psilcy`, `peyote`, `mesc`, `ecstmolly`,
  `ketminesk`, `dmtamtfxy`, `pcp`, `salviadiv`; coded 1=yes 2=no with
  85/89/91/93/94/97/98 special codes) and 0/1 recodes (`*flag`, `*yr`, `*mon`,
  `hallucevr`, `hallucyr`, …) — prefer the recodes for prevalence
- demographics: `age3`, `catag6`, `irsex`, `newrace2`, `ireduhighst2`,
  `income`, `coutyp4`, `irinsur4`
- mental health: `spdpstmon`/`spdpstyr` (serious psychological distress),
  `amdeyr`, `suicthnk`, raw K6 items `dst*30`

## Working discipline (RWD QC)

- Spot-check any predicate before trusting a count
  (`SELECT <col>, count(*) FROM nsduh.nsduh_2023 GROUP BY 1 ORDER BY 1` —
  the special codes 91/93/etc. must be handled explicitly).
- Stage multi-step queries via `sandbox`/temp tables rather than one giant
  statement; record the staging SQL with the driver script.
- Pull the columns you need with SQL; do the weighting and modeling in R
  (`survey`/`srvyr`: `svydesign(ids = ~verep, strata = ~vestr_c,
  weights = ~analwt2_c, nest = TRUE)`).
- Record every driver script + source table in the output directory's
  `provenance.md`; cache plotted data next to figures.
