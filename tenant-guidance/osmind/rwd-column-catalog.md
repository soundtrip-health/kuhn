# Osmind RWD Column Catalog

> ⚑ **Osmind-specific — data warehouse schema.** This entire document describes
> Osmind's production real-world-data warehouse: schemas, tables, columns,
> predicate idioms, and quirks. The *practices* (spot-check free-text predicates,
> QC event dates, prefer structured fields, document temp-schema conventions)
> generalize to any EHR/RWD warehouse; the *names* are Osmind's.

Every RWD analysis draws from the same warehouse, so useful columns, idioms, and
quirks belong in one catalog rather than being re-discovered per project. This is
a **catalog**, not a tutorial — it lists the columns analysts reach for and the
predicate idioms that work. Pair it with a project's own analyst SQL.

**How to use:** pick the question (diagnosis history, treatment exposure,
outcomes, vitals, intake facts); find the section; copy the predicate sketch;
cross-check against *Quirks* before relying on a count.

## Schemas

| schema | what lives there | read posture |
|---|---|---|
| `analytics_omop` | OMOP CDM v5.4-style tables (`person`, `condition_occurrence`, `procedure_occurrence`, `measurement`, `observation`, `note`, `visit_occurrence`, `drug_exposure`, `care_site`, `provider`, `location`, `payer_plan_period`, `cost`). Osmind-specific columns prefixed `_` (e.g. `_condition_concept_code`). | read-only |
| `analytics` | Non-OMOP fact tables — clinical-note JSONB (`fact_clinical_notes`), intake-form responses (`fact_intake_form_response`), other workflow artifacts. | read-only |
| `<project>_temp` | Per-project scratch schema for derived cohort tables (`nrx_temp`, `mmb_temp`, …) to avoid collisions. | CREATE/DROP, scoped to this schema only |

## Patient identifier

The patient key is `text`. In OMOP it is `person_id`; in `analytics.*` it is
`patient_id` — the **same identifier**. When joining across the two domains, cast
defensively to `text` on both sides: `ON fcn.patient_id = pt.person_id::text`.
`analytics_omop.person._golden_person_id` is the cross-EHR linking key for
identity de-duplication across source systems.

## Diagnosis history — `analytics_omop.condition_occurrence`

| column | purpose |
|---|---|
| `person_id` | patient |
| `_condition_concept_code` | ICD-10 string with dots (`F43.10`, `F33.1`). Use `LIKE 'F43%'`-style predicates. |
| `_condition_concept_name` | human-readable concept name |
| `condition_start_date` | dx date — the canonical date column |
| `condition_end_date` | rarely populated; do not rely on |
| `condition_status_source_value` | sometimes "primary"/"secondary" but **not reliable** and null for most rows |

```sql
-- patients with any PTSD diagnosis (F43.1 family)
SELECT DISTINCT person_id FROM analytics_omop.condition_occurrence
WHERE _condition_concept_code LIKE 'F43.1%';

-- first MDD diagnosis per patient
SELECT person_id, MIN(condition_start_date) AS first_mdd
FROM analytics_omop.condition_occurrence
WHERE _condition_concept_code LIKE 'F32%' OR _condition_concept_code LIKE 'F33%'
GROUP BY person_id;
```

- **Code presence — psychotic spectrum & bipolar (confirmed 2026-05-30).** Standard exclusions
  present: schizophrenia `F20.x`, schizotypal `F21`, delusional `F22`, brief psychotic `F23`,
  schizoaffective `F25.x`, other/unspecified psychotic `F28`/`F29`. **`F24` has zero rows.**
  Bipolar is `F31.x` and does **not** split I vs II at the family level — `F31.81` (Bipolar II)
  is the largest subcode (~9.8k pts), `F31.9` (unspecified) ~8.5k; bipolar-depression episodes
  are `F31.3x`/`F31.4`/`F31.5`. Spot-check before trusting an exclusion count.
- **Quirk — no primary-dx flag.** OMOP `condition_occurrence` in Osmind does **not** expose a
  clean primary-vs-secondary flag. Counts use "any condition_occurrence record."
- **Quirk — 4-character stubs.** Some upstream EHRs truncate ICD codes to category level
  (`F43.1` with no 5th digit). Patient-level totals **must include the stub** to match the
  full-code subset. `LIKE 'F43.1%'` catches `F43.10/11/12` **and** the bare `F43.1` stub.

## Treatment exposure — `analytics_omop.procedure_occurrence`

| column | purpose |
|---|---|
| `person_id` | patient |
| `_procedure_concept_name` | canonical name. Observed values with distinct-patient counts (2026-06-09): `Evaluation` (80,947), `Ketamine` (72,768), `Psychotherapy` (12,866), `Esketamine` (8,936), `Transcranial magnetic stimulation` (3,434), `Dispensing medication management` (2,096), `No matching concept` (1,871). Detect TMS by concept name alone. |
| `_route_concept_name` | `Intravenous`, `Nasal`, `Intramuscular`, `Oral`. Pair with concept name to define a treatment. |
| `procedure_date` | event date — canonical |
| `procedure_datetime`, `procedure_time`, `procedure_end_date`, `procedure_end_datetime` | finer timing when present |
| `procedure_source_value`, `_procedure_source_code_value` | raw CPT/HCPCS string |

```sql
-- first IV ketamine OR IN esketamine exposure per patient
WITH first_per_treatment AS (
  SELECT person_id, _procedure_concept_name AS treatment, MIN(procedure_date) AS first_date
  FROM analytics_omop.procedure_occurrence
  WHERE ((_procedure_concept_name = 'Ketamine'   AND _route_concept_name = 'Intravenous')
      OR (_procedure_concept_name = 'Esketamine' AND _route_concept_name = 'Nasal'))
    AND procedure_date BETWEEN '2021-01-01' AND '2026-03-31'
  GROUP BY person_id, _procedure_concept_name)
SELECT person_id, treatment, first_date FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY first_date, treatment) AS rn
  FROM first_per_treatment) ranked WHERE rn = 1;
```

- **Quirk — route precision.** `Ketamine + Intravenous` and `Esketamine + Nasal` are the
  canonical pairs. Off-route administrations are missed by predicates locking both name and
  route.
- **Convention — `procedure_occurrence` is the canonical index record for ketamine and
  esketamine.** Define first-exposure/index dates from `procedure_occurrence` only — it is the
  per-session administration record with an accurate `procedure_date`. The same agents appear
  in `drug_exposure` (order/dispensing-style rows with looser dating — e.g. ~1,950 NULL-route
  esketamine rows and a malformed `0202-01-01` date). **Do not use `drug_exposure` to set a
  ketamine/esketamine index date** (it is still valid for *ever-exposed* exclusion sets).

## Drug exposure — `analytics_omop.drug_exposure`

| column | purpose |
|---|---|
| `person_id` | patient |
| `_drug_concept_name` | brand or specific product |
| `_drug_generic_concept_name` | generic ingredient — preferred for class-level analyses |
| `_drug_generic_concept_id` | concept ID for the generic — feed to RxNav/RxClass |
| `drug_exposure_start_date`, `drug_exposure_end_date`, `days_supply` | exposure window |
| `route_concept_id`, `_route_concept_name` | route |
| `refills`, `quantity`, `sig` | prescribing detail |

**Antidepressant classifications** (static curated taxonomy; a dynamic ATC/RxClass classifier
exists too):

- **SSRI:** citalopram, escitalopram, fluoxetine, fluvoxamine (OCD; low/zero in PTSD/MDD),
  paroxetine, sertraline.
- **SNRI:** desvenlafaxine, duloxetine, levomilnacipran, milnacipran (pain; low/zero
  psychiatric), venlafaxine.
- **NDRI:** bupropion. **SNDRI:** toludesvenlafaxine (not FDA-approved US as of 2026; ~zero).
- **SMS (serotonin modulators/stimulators):** vortioxetine, vilazodone.
- **SARI:** nefazodone (hepatotoxicity; rare), trazodone (often low-dose for sleep, not
  antidepressant treatment).
- **TeCA:** amoxapine (rare), maprotiline (rare), mirtazapine (may be for sleep; distinguish
  monotherapy from add-on).

Clinical interpretation: low/zero counts expected for fluvoxamine, milnacipran,
toludesvenlafaxine, nefazodone, amoxapine, maprotiline. Trazodone and mirtazapine may reflect
sleep-targeted prescribing. Other TCAs (amitriptyline, imipramine, desipramine) are not in the
helper taxonomy; interpret cautiously if added (low-dose use may reflect sleep or migraine).

## Patient demographics — `analytics_omop.person`

| column | purpose |
|---|---|
| `person_id` | PK |
| `_golden_person_id` | cross-EHR identity link |
| `year_of_birth` | calendar-year age subtraction is accurate to ±1 year |
| `_gender_concept_value`, `gender_source_value` | gender |
| `_race_concept_value`, `_ethnicity_concept_value` | race/ethnicity (free-text) |
| `location_id` | join to `location` for ZIP/state |
| `_source_created_at` | proxy for "first appearance of this patient in the warehouse" |
| `_ehr` | source EHR system label |

- **Quirk — calendar-year age.** Most projects compute `year(event_date) − year_of_birth`
  (calendar-year accurate only).
- **Quirk — demographics-cleanup token mismatch.** The cleanup helper silently returns `NaN`
  because live values don't match its tokens: `_gender_concept_value` stores `'FEMALE'`/`'MALE'`
  (not `'F'`/`'M'`), and `_ethnicity_concept_value` stores `'Not Hispanic or Latino'` (not `'Non
  Hispanic or Latino'`). Unknowns appear as `'No matching concept'`. For binary PS/SMD
  indicators, derive directly from the raw column — e.g. `female = upper(_gender_concept_value)
  in ('FEMALE','MALE') → {1,0}`; `hispanic = lower(_ethnicity_concept_value) startswith
  'hispanic or latino' → 1 else 0` (the leading "Not" makes `'Not Hispanic or Latino'` map to 0).

## Patient-reported outcomes / instruments — `analytics_omop.measurement`

Survey-style PROs (PCL-5, PHQ-9, GAD-7, MADRS, C-SSRS, CADSS) are stored as measurements.

| column | purpose |
|---|---|
| `person_id` | patient |
| `measurement_source_value` | free-text instrument name — the workhorse predicate column; ILIKE required |
| `_measurement_concept_name` | concept name; less reliably populated |
| `measurement_date` | event date |
| `value_as_number`, `_value_as_text` | numeric or text score |

```sql
-- PCL-5
WHERE measurement_source_value ILIKE '%PCL-5%' OR measurement_source_value ILIKE '%PCL5%';
-- C-SSRS
WHERE measurement_source_value ILIKE '%C-SSRS%' OR measurement_source_value ILIKE '%CSSRS%'
   OR measurement_source_value ILIKE '%Columbia%';
```

- **Quirk — free-text matching.** All instrument predicates are ILIKE patterns on free text. A
  vendor shipping `PCL-M` (military) would be missed. Spot-check `SELECT DISTINCT
  measurement_source_value …` before trusting a new instrument list.
- **Quirk — MADRS total vs. items; MADRS is a Spravato-clinic instrument.** The MADRS *total*
  is `measurement_source_value = 'MADRS'` (0–60); longer `'MADRS: Montgomery-Asberg…'` strings
  are item-level rows — use the exact-match predicate (as with `PHQ-9`). MADRS is **sparse and
  concentrated in the IN-esketamine population**: of 4,630 patients with any MADRS total
  (2026-06-25), 82% also have an esketamine/ketamine/TMS procedure. Cohorts excluding
  interventional treatments will have almost no MADRS coverage; **PHQ-9 is the only PRO with
  broad capture across non-interventional comparators.**

**C-SSRS interpretation.** Yes/no answers are mapped to a standard 0–7 suicidality scale
(Columbia Lighthouse Project Scoring Guide): 0 no suicidality; 1 wish to be dead (passive); 2
nonspecific active thoughts; 3 active ideation with method; 4 active ideation with intent; 5
active ideation with plan and intent; 6 preparatory acts or behavior; 7 suicidal attempt.

## Structured observations (intake/visit items) — `analytics_omop.observation`

Smaller structured items, including six routine suicidal-ideation question keys captured at
intake/visit time.

| column | purpose |
|---|---|
| `person_id` | patient |
| `observation_source_value` | structured item key (`suicidal_ideation`, `suicidal_plan`) — predicate column |
| `observation_date` | event date |
| `value_as_number`, `value_as_string`, `value_as_concept_id`, `value_source_value` | answer |

These SI items are roughly 50–70× denser in 0–14 / 14–28 day post-treatment windows than formal
C-SSRS administrations. **Value semantics (verified 2026-05-17):** the six SI items store
answers in `value_source_value` as **unquoted literals**, not JSON strings (opposite of
`fact_intake_form_response`). The three Boolean items are literally `'true'`/`'false'`; two
free-text items hold short categorical strings with vendor casing.

| `observation_source_value` | typical `value_source_value` | shape |
|---|---|---|
| `patient_denies_suicidal_ideation` | `'true'` (≈1.8M) / `'false'` (≈33k) | Boolean literal |
| `suicidal_ideation` | `'true'` (≈60k) / `'false'` (≈765k) | Boolean literal |
| `suicidal_plan` | `'true'` (≈3.4k) / `'false'` (≈430k) | Boolean literal |
| `suicidal_intent` | `'true'` (≈900) / `'false'` (≈433k) | Boolean literal |
| `suicidal_frequency` | `'daily'`, `'Daily'`, `'fleeting'`, … | mixed-case free text |
| `suicidal_details` | `'passive'`, `'PDW no plan/intent/means'`, `'Denies plan.'`, … | free text |

```sql
-- positive-SI predicate (Boolean-only — safest without resolving free-text casing)
WHERE ((observation_source_value = 'suicidal_ideation'  AND value_source_value = 'true')
    OR (observation_source_value = 'suicidal_plan'       AND value_source_value = 'true')
    OR (observation_source_value = 'suicidal_intent'     AND value_source_value = 'true')
    OR (observation_source_value = 'patient_denies_suicidal_ideation' AND value_source_value = 'false'))
```

- **Quirk — `value_source_value` is unquoted on `observation`.** Use `= 'true'` (not
  `'"true"'`) — the **opposite** of `fact_intake_form_response.answer`, which JSON-quotes its
  values. Review the two side-by-side.
- **Quirk — `suicidal_frequency`/`suicidal_details` need curation.** Default to the four Boolean
  items for any SI/B cohort definition; reach for free-text items only when willing to enumerate
  positive values.

## Clinical notes — free text and JSONB

- `analytics_omop.note` — note text with `note_title` (enum-like; ketamine-session titles:
  `iv_notes`, `ketamine_notes`, `treatment_notes`, `discharge_notes`, `spravato_discharge_notes`,
  `clinical_note_content`), `note_text` (free-text; ILIKE/regex), `note_date`.
- `analytics.fact_clinical_notes` — the authoritative source for **all structured fields
  captured on a note row**, including vitals JSONB and per-item Boolean responses. (The OMOP
  `measurement` layer for vitals is sparse; the same vitals are captured at scale here.)

Key `fact_clinical_notes` columns: `patient_id` (TEXT, matches `person_id::text`); `note_type`
(use `ILIKE '%ketamine%'` for IV/IM; `ILIKE '%spravato%'`/`'%esketamine%'` for Spravato);
`appointment_date` (TIMESTAMPTZ — **canonical clinical date**, populated on essentially every
ketamine/Spravato note); `inferred_appointment_date` (fallback for the rare NULL
`appointment_date`; idiom `COALESCE(appointment_date::DATE, inferred_appointment_date::DATE)`);
`created_at` (row creation — **not** the clinical date); `signed_date` (TEXT; rarely useful);
`saved_vital_signs` (JSONB array of per-timepoint measurement objects for IV/IM notes);
`saved_discharge_vital_signs`; `start/forty_min/end_spravato_vitals` (three Spravato
timepoints); `bladder_sx` (structured Boolean; `IS NOT NULL` = capture availability, `IS TRUE`
= positive symptom).

```sql
-- clinical-notes time-window join (anchor on appointment_date vs an OMOP index date)
SELECT pt.person_id,
       COALESCE(n.appointment_date::DATE, n.inferred_appointment_date::DATE) - pt.index_date AS days_from_index
FROM mmb_temp.<cohort> pt
JOIN analytics.fact_clinical_notes n ON n.patient_id = pt.person_id::text
 AND COALESCE(n.appointment_date::DATE, n.inferred_appointment_date::DATE) IS NOT NULL
WHERE n.bladder_sx IS NOT NULL
  AND (n.note_type ILIKE '%ketamine%' OR n.note_type ILIKE '%spravato%' OR n.note_type ILIKE '%esketamine%');
```

Cast `appointment_date` (`timestamptz`) to `DATE` before subtracting from an OMOP `*_date`
(plain `date`) so the result is integer days. Unnest vitals JSONB with a `jsonb_typeof`-guarded
LATERAL pattern that handles array, object, **and** the double-encoded-string case.

- **Quirk — JSONB stored as double-encoded string.** ~27k IV/IM rows hold `saved_vital_signs`
  as a JSON-encoded string (`jsonb_typeof = 'string'`); the guarded idiom skips them.
- **Quirk — `Temp` is never populated** in the vitals JSONB.

**Per-session dose columns (confirmed 2026-06-25).** IV/IM ketamine notes (`note_type ILIKE
'%ketamine%'`; `'IV Ketamine'`, `'IM Ketamine'`): `ketamine_dose` (numeric, **mg/kg**, directly
entered — 135,788 rows / 20,696 patients); `ketamine_total_dose` (total mg per session — 376,071
rows / 48,181 patients); `patient_weight` (text numeric string, no unit — 495,023 rows / 64,317
patients); `ketamine_units` (`'kg'`/`'lbs'`/`'lb'`). `ketamine_dose` p5–p95: 0.50–0.62–0.80–1.00–1.85
mg/kg. **CRITICAL — no double-normalization:** `ketamine_dose` IS already mg/kg; do NOT divide
by weight again. Spravato / IN esketamine notes (`note_type ILIKE '%spravato%'`; `'Spravato'`,
`'Spravato v2'`): `spravato_dose` (numeric, **mg** total — values 56 or 84 only, matching the
FDA REMS schedule; 98.2% of rows, 92.1% of patients).

- **Quirk — weight coverage asymmetry.** IV-ketamine notes capture `patient_weight` for ~84% of
  study-arm patients; Spravato notes only ~52%. Esketamine effective-dose analyses requiring
  weight have materially reduced sample size — consider a weight-observed sensitivity analysis.
- **Quirk — `patient_weight` needs a plausibility filter.** Outliers exist (e.g. `'26070'` lbs).
  Apply `patient_weight::numeric BETWEEN 20 AND 500` before unit conversion (unit-agnostic).

## Visits / encounters — `analytics_omop.visit_occurrence`

`person_id`; `visit_start_date`/`visit_end_date`; `_visit_concept_name`; `care_site_id`/
`provider_id`. Use the UNION of `procedure_date` ∪ `visit_start_date` ∪ `measurement_date`
(and `note.note_date` as a 4th source) to define "any patient activity" for retention or
post-treatment-contact denominators.

## Intake-form responses — `analytics.fact_intake_form_response`

Structured intake answers (military/social history, demographics, substance use); superior to
free-text `observation` scans for fields captured as structured questions. `patient_id`;
`form_section`; `question_key`; `answer` (**JSON-quoted string** — `'"true"'`, not `'true'`).

```sql
SELECT DISTINCT patient_id FROM analytics.fact_intake_form_response
WHERE form_section = 'social_history' AND question_key = 'HAS_SERVED_IN_MILITARY' AND answer = '"true"';
```

- **Quirk — quoted answers.** `answer = 'true'` returns 0 rows; use `answer = '"true"'`
  (equivalently `answer::jsonb = 'true'::jsonb`).

## Cost / payer / location / provider / care site

`location.{zip, state}` (ZIP → median income via the US Census ACS-5 helper);
`provider.{_specialty}`; `care_site`; `payer_plan_period` (insurance-based subgroups);
`cost.*` (financial; rarely needed for clinical feasibility).

## Event-date QC *(standing rule)*

Every OMOP event-bearing table carries two timestamp families: the clinical `<event>_date`
(clinician-entered/patient-reported event date — the canonical analytic date when meaningful)
and `_source_created_at` (`timestamptz`, the **row-write** timestamp — available on every
event-bearing OMOP table plus `person`; companion `_source_updated_at`).

**Always sanity-check `event_date` before trusting any `MIN`/`MAX`/window derivation.** Two
failure modes recur: future-dated rows (typos, `2031-…`) — trim with `event_date <=
CURRENT_DATE`; and implausibly ancient rows (patient-reported history stored with the
self-reported event date — year 0201, 1860, epoch `1969-12-31`) — these bite hardest under
`MIN(event_date)` per patient. **Discovery (2026-05-28, Spravato cohort):** 41.8% had
`MIN(event_date)` ≥5 years pre-index; 87% of those had only a single distinct event date in
their first 365 days; ~67% of Spravato patients passing a 1-year pre-index observability gate
were passing on a stray ancient date.

```sql
-- A. trim impossible dates (always)
event_date BETWEEN '2010-01-01' AND CURRENT_DATE
-- B. require dense observation, not a single stray row
COUNT(DISTINCT event_date) FILTER (WHERE event_date BETWEEN t_index - 365 AND t_index) >= 4
-- C. anchor observability on the row-write timestamp
MIN(_source_created_at::date) AS t_first_obs_in_warehouse
```

**Which column to use:** "when did the patient's depression begin?" → `event_date`
(bounds-trimmed). "Observable in our data ≥N days pre-index?" → `_source_created_at::date` (not
`MIN(event_date)`). First/last contact for retention → `_source_created_at::date`, UNIONed.
Cumulative-incidence anchors, severity-window gates → `event_date` after trimming. **Caveat:**
for data ingested from an external EHR at a one-time integration, `_source_created_at` can be
the ingest timestamp, underestimating observability for migrated patients — spot-check by
`_ehr`.

## Cross-cutting quirks

| Quirk | Where it bites |
|---|---|
| All `id` columns are `text`. | Cast defensively joining `analytics_omop.*` to `analytics.*`. |
| Free-text `*_source_value` drives most instrument/drug/procedure predicates. | Spot-check `SELECT DISTINCT … LIMIT 50` for naming variants. |
| ICD codes use dots and may be truncated to category level. | Predicates must include the stub (`'F43.1%'`). |
| Future-dated rows exist. | Add `event_date <= CURRENT_DATE`. |
| Implausibly ancient `event_date` (patient-reported history). | Any `MIN(event_date)` observability gate silently inflates; prefer `_source_created_at::date`. |
| Vitals are in JSONB on `fact_clinical_notes`, not `measurement`. | Vital-sign feasibility, safety surveillance. |
| Many JSONB columns mix array / object / double-encoded-string shapes. | Use a `jsonb_typeof`-guarded LATERAL pattern. |
| OMOP has no primary-vs-secondary diagnosis flag. | Diagnosis counts are always "any record." |
| `fact_intake_form_response.answer` is JSON-quoted; `observation.value_source_value` is un-quoted. | `'"true"'` vs `'true'` — check both side-by-side. |
| Clinical-notes clinical date is `appointment_date` (TIMESTAMPTZ), not `created_at`/`signed_date`. | Time-window joins; fall back to `inferred_appointment_date`. |
| Patterns locking both `_procedure_concept_name` AND `_route_concept_name` miss off-route administrations. | Treatment-exposure cohorts. |
| `person.year_of_birth` completeness varies sharply by treatment (IV-ketamine has a large NULL/implausible minority; Spravato/IN-esketamine near-complete). | Age gates: treat "DOB undeterminable" as age-ineligible; attribute the drop as data completeness, not pediatric exposure. |
| Per-cohort-row `EXISTS(… million-row table …)` does not plan as a semi-join at scale. | Rewrite as a single-pass `JOIN` with per-patient `BOOL_OR(...)` / `COUNT(*) FILTER (...)` aggregation. |

## Per-project temp-schema convention

Each project picks its own temp schema to avoid collisions; document the choice at the top of
its analyst README/notes. Known schemas: `nrx_temp` (nrx-rwe-protocol, closed), `mmb_temp` (mmb
/ FTR-101 PTSD).

## When this catalog is wrong

Schemas evolve. If a listed column returns 0 rows or `column does not exist`, re-run the schema
reconnaissance against the live database (every analyst pipeline has a `schema_reconnaissance()`
helper that dumps `information_schema.columns`). Update this file with the current shape, add a
*Quirks* entry when a non-obvious behavior is discovered, and surface updates to the PI.
