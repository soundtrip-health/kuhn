# NSDUH 2023 extract — variable guide

Codebook notes for the analysis dataset used by this test project. The data
is served from Postgres (`nsduh.nsduh_2023`, loaded by `load-nsduh.sh` from
the extract CSV; **column names are lowercased** there — see `db-guide.md`
for connection and schema). The
authoritative reference is the official
[2023 PUF codebook](https://www.samhsa.gov/data/system/files/media-puf-file/nsduh-2023-ds0001-info-codebook_v2.pdf);
**the generated `build/extract-manifest.md` is the ground truth for which
variables actually made it into the extract** — the prep script selects by
name/pattern and reports found/missing, so treat any name below as a candidate
until the manifest confirms it.

## Survey design (confirmed against the 2023 PUF Data Users' Guide)

| Variable | Meaning |
|---|---|
| `QUESTID2` | Respondent identifier |
| `ANALWT2_C` | Person-level analysis weight (sums to the civilian, non-institutionalized US population 12+) |
| `VESTR_C` | Variance-estimation stratum |
| `VEREP` | Variance-estimation replicate (nest within `VESTR_C`) |

Every estimate reported in the manuscript must use `ANALWT2_C`; design-based
SEs/CIs use `VESTR_C` × `VEREP` (Taylor-series, e.g. R `survey::svydesign(ids
= ~VEREP, strata = ~VESTR_C, weights = ~ANALWT2_C, nest = TRUE)`).

## Psychedelic substances (broad definition for this project)

Selected by pattern — the PUF carries raw items, imputation-revised (`IR*`)
recodes, and lifetime/past-year recode flags per substance. Expected stems:

| Stem(s) | Substance |
|---|---|
| `LSD*` | LSD |
| `PSILCY*` | Psilocybin (also see the mushroom items) |
| `PEYOTE*`, `MESC*` | Peyote, mescaline |
| `DMTAMTFXY*` | DMT / AMT / 5-MeO-DIPT ("Foxy") tryptamines |
| `ECSTMOLLY*`, `ECSTMO*` | MDMA / ecstasy / Molly |
| `KETMINESK*`, `KETMIN*` | Ketamine (incl. esketamine wording in recent waves) |
| `PCP*` | Phencyclidine |
| `SALVIA*` | Salvia divinorum |
| `HALLUC*` (e.g. `HALLUCEVR`, `HALLUCYR`) | Any-hallucinogen aggregate recodes |

Response codes: the `*FLAG`/`*YR`/`*MON` recode variables are already 0/1
(0 = no/never, 1 = yes) — prefer them for prevalence. Raw items (`LSD`,
`ECSTMOLLY`, `KETMINESK`, …) use `1` = yes, `2` = no, plus `85/89/94/97/98`
DK/refused/skip codes and `91` ("never used <class>") / `93` ("did not use in
period") — recode before analysis.

## Demographics & mental health (confirmed against the 2023 PUF)

Age (`AGE3`/`CATAG6`/`CATAG3`), sex (`IRSEX`), race/ethnicity (`NEWRACE2`),
education (`IREDUHIGHST2`/`EDUHIGHCAT`), family income (`INCOME`), county
metro status (`COUTYP4`), health insurance (`IRINSUR4`).

Mental health — note the 2023 PUF does **not** carry the older `K6SCMON`/
`SPDMON` names: serious psychological distress recodes are `SPDPSTMON`
(past month) and `SPDPSTYR` (past year); the raw K6 items are `DSTNRV30`,
`DSTHOP30`, `DSTRST30`, `DSTCHR30`, `DSTEFF30`, `DSTNGD30` (30-day) with
imputation-revised `IRDST*30`/`IRDST*12` versions and `IRDSTWORST`; serious
mental illness recodes `SMIPY`/`SMIPPPY`; past-year major depressive episode
`AMDEYR` (youth `YMDEYR`); suicidal ideation `SUICTHNK`/`IRSUICTHNK`.

## Notes for the analyst

- One row per respondent; the CSV is the full 2023 sample (56,705 rows),
  columns restricted to the above (no `YEAR` column — the file is 2023 only).
- Public-use file: geography and other identifying detail are suppressed by
  design. Do not attempt re-identification.
- Prevalence denominators: the PUF represents persons **aged 12+**; say so in
  Methods. Sub-analyses on adults should filter on the age recode.
