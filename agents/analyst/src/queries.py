"""ASCP 2026 analysis queries."""

from __future__ import annotations

import os

import pandas as pd

import numpy as np
from drug_lookup import DrugLookup
from postgres_client import PostgresClient
from utils import ANTIDEPRESSANTS, TABDIR, clean_demographics, fetch_all_zip_median_income


class ASCPQueries:
    """Query interface for ASCP 2026 ketamine/esketamine analysis."""

    def __init__(
        self,
        connection_url: str | None = None
    ):
        self.db = PostgresClient(connection_url)

    def create_first_exposure_table(self, treatments: list[str] | None = None) -> None:
        """Create nrx_temp.first_exposure table with first treatment date per patient."""
        if treatments is None:
            treatments = ["Ketamine", "Esketamine"]

        placeholders = ",".join(["%s"] * len(treatments))
        q = f"""
            CREATE TABLE nrx_temp.first_exposure AS
            SELECT
                po.person_id,
                MIN(po.procedure_date) AS index_date,
                po._procedure_concept_name AS treatment
            FROM analytics_omop.procedure_occurrence po
            WHERE _procedure_concept_name IN ({placeholders})
            GROUP BY po.person_id, po._procedure_concept_name
        """

        with self.db.transaction():
            self.db.execute("CREATE SCHEMA IF NOT EXISTS nrx_temp")
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.first_exposure")
            self.db.execute(q, tuple(treatments))
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_first_exposure_person_id ON nrx_temp.first_exposure (person_id)")
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_first_exposure_treatment ON nrx_temp.first_exposure (treatment)")
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_first_exposure_index_date ON nrx_temp.first_exposure (index_date)")

        q = """
        SELECT treatment, COUNT(person_id) AS num_participants
        FROM nrx_temp.first_exposure 
        GROUP BY (treatment);
        """
        with self.db.transaction():
            rows = self.db.select(q)
        return pd.DataFrame(rows)

    # ------------------------------------------------------------------
    # Cohort enumeration (8-step sequential filtering)
    # ------------------------------------------------------------------

    def _count_by_arm(self, table: str) -> dict:
        """Return {treatment: count} for a ce_step table."""
        rows = self.db.select(
            f"SELECT treatment, COUNT(*) AS n FROM {table} GROUP BY treatment"
        )
        return {r["treatment"]: r["n"] for r in rows}

    def _step_row(self, step: int, description: str, counts: dict, prev_total: int | None = None) -> dict:
        n_ket = counts.get("Ketamine", 0)
        n_esk = counts.get("Esketamine", 0)
        n_total = n_ket + n_esk
        row = {
            "step": step,
            "description": description,
            "n_total": n_total,
            "n_ketamine": n_ket,
            "n_esketamine": n_esk,
        }
        if prev_total is not None:
            row["n_excluded"] = prev_total - n_total
            row["pct_retained"] = round(100 * n_total / prev_total, 1) if prev_total > 0 else 0.0
        return row

    def _step_row_from_prev(
        self,
        step: int,
        description: str,
        counts: dict,
        prev_counts: dict | None = None,
    ) -> dict:
        """Build a step row with by-arm retained/excluded metrics."""
        row = self._step_row(step, description, counts, None)
        if prev_counts is None:
            return row
        prev_ket = prev_counts.get("Ketamine", 0)
        prev_esk = prev_counts.get("Esketamine", 0)
        prev_total = prev_ket + prev_esk
        row["n_excluded_ketamine"] = prev_ket - row["n_ketamine"]
        row["n_excluded_esketamine"] = prev_esk - row["n_esketamine"]
        row["n_excluded"] = prev_total - row["n_total"]
        row["pct_retained"] = round(100 * row["n_total"] / prev_total, 1) if prev_total > 0 else 0.0
        return row

    def run_cohort_enumeration(
        self,
        study_start: str = "2021-01-01",
        study_end: str = "2026-03-31",
        min_birth_year: int = 1920,
        max_birth_year: int = 2020,
    ) -> tuple[pd.DataFrame, dict]:
        """Run cohort enumeration per updated feasibility spec.

        Creates temp tables nrx_temp.ce_step1 … ce_step7 and returns:
            summary_df: One row per step with total and by-arm counts.
            details: Supplementary counts (same-day dual, psych exclusions,
                     TRD ascertainment, safety set, arm ratio, etc.).
        """
        details: dict = {}
        details["ambiguities"] = [
            "Step 0 source-population 'any record during period' currently uses person._source_created_at as proxy."
        ]
        with self.db.transaction():
            self.db.execute("CREATE SCHEMA IF NOT EXISTS nrx_temp")

        results = []

        # ── Step 0: Source population ─────────────────────────────────
        with self.db.transaction():
            rows = self.db.select("""
                SELECT COUNT(DISTINCT person_id) AS n
                FROM analytics_omop.person
                WHERE _source_created_at >= %s::DATE
                  AND _source_created_at <= %s::DATE
                  AND year_of_birth > %s
                  AND year_of_birth < %s
            """, (study_start, study_end, min_birth_year, max_birth_year))
        n_step0 = rows[0]["n"]
        results.append({
            "step": 0, "description": "Source population",
            "n_total": n_step0, "n_ketamine": None, "n_esketamine": None,
        })

        # ── Step 1: Treatment initiation ──────────────────────────────
        # Find first administration of each treatment per patient,
        # assign arm based on whichever came first, exclude same-day dual starters.
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step1")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step1 AS
                WITH first_per_treatment AS (
                    SELECT person_id,
                           _procedure_concept_name AS treatment,
                           MIN(procedure_date) AS first_date
                    FROM analytics_omop.procedure_occurrence
                    WHERE _procedure_concept_name IN ('Ketamine', 'Esketamine')
                      AND _route_concept_name IN ('Intravenous', 'Nasal')
                      AND NOT (
                          (_source_created_at::DATE - procedure_date) > 10
                          AND (_source_updated_at::DATE - procedure_date) > -1
                      )
                    GROUP BY person_id, _procedure_concept_name
                ),
                ranked AS (
                    SELECT person_id, treatment, first_date,
                           ROW_NUMBER() OVER (
                               PARTITION BY person_id
                               ORDER BY first_date, treatment
                           ) AS rn
                    FROM first_per_treatment
                ),
                same_day_dual AS (
                    SELECT DISTINCT r1.person_id
                    FROM ranked r1
                    JOIN ranked r2
                      ON r1.person_id = r2.person_id
                     AND r1.treatment <> r2.treatment
                     AND r1.first_date = r2.first_date
                )
                SELECT r.person_id,
                       r.treatment,
                       r.first_date AS index_date,
                       DATE_PART('year', r.first_date) - p.year_of_birth AS age_at_index
                FROM ranked r
                JOIN analytics_omop.person p ON p.person_id = r.person_id
                WHERE r.rn = 1
                  AND r.person_id NOT IN (SELECT person_id FROM same_day_dual)
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step1_pid ON nrx_temp.ce_step1 (person_id)"
            )

        # Count same-day dual exclusions for reporting
        with self.db.transaction():
            rows = self.db.select("""
                WITH first_per_treatment AS (
                    SELECT person_id,
                           _procedure_concept_name AS treatment,
                           MIN(procedure_date) AS first_date
                    FROM analytics_omop.procedure_occurrence
                    WHERE _procedure_concept_name IN ('Ketamine', 'Esketamine')
                      AND _route_concept_name IN ('Intravenous', 'Nasal')
                      AND NOT (
                          (_source_created_at::DATE - procedure_date) > 10
                          AND (_source_updated_at::DATE - procedure_date) > -1
                      )
                    GROUP BY person_id, _procedure_concept_name
                )
                SELECT COUNT(DISTINCT f1.person_id) AS n
                FROM first_per_treatment f1
                JOIN first_per_treatment f2
                  ON f1.person_id = f2.person_id
                 AND f1.treatment <> f2.treatment
                 AND f1.first_date = f2.first_date
            """)
        details["n_same_day_dual"] = rows[0]["n"]

        with self.db.transaction():
            step1_counts = self._count_by_arm("nrx_temp.ce_step1")
        results.append(self._step_row(1, "Treatment initiation", step1_counts, n_step0))

        # ── Step 2: Treatment-naïve to comparator ─────────────────────
        # Exclude patients with ANY exposure to both treatments at any time.
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step2")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step2 AS
                WITH dual_exposed AS (
                    SELECT person_id
                    FROM (
                        SELECT DISTINCT person_id, _procedure_concept_name
                        FROM analytics_omop.procedure_occurrence
                        WHERE _procedure_concept_name IN ('Ketamine', 'Esketamine')
                          AND _route_concept_name IN ('Intravenous', 'Nasal')
                          AND NOT (
                              (_source_created_at::DATE - procedure_date) > 10
                              AND (_source_updated_at::DATE - procedure_date) > -1
                          )
                    ) t
                    GROUP BY person_id
                    HAVING COUNT(DISTINCT _procedure_concept_name) = 2
                )
                SELECT s.*
                FROM nrx_temp.ce_step1 s
                WHERE s.person_id NOT IN (SELECT person_id FROM dual_exposed)
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step2_pid ON nrx_temp.ce_step2 (person_id)"
            )

        with self.db.transaction():
            step2_counts = self._count_by_arm("nrx_temp.ce_step2")
            # Count dual-exposed for reporting
            rows = self.db.select("""
                SELECT s.treatment, COUNT(*) AS n
                FROM nrx_temp.ce_step1 s
                WHERE s.person_id NOT IN (
                    SELECT person_id FROM nrx_temp.ce_step2
                )
                GROUP BY s.treatment
            """)
        details["n_dual_exposed_by_arm"] = {r["treatment"]: r["n"] for r in rows}
        details["n_dual_exposed_total"] = sum(details["n_dual_exposed_by_arm"].values())
        results.append(self._step_row_from_prev(2, "Treatment-naïve to comparator", step2_counts, step1_counts))

        # ── Step 3: Age ≥ 18 ─────────────────────────────────────────
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step3")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step3 AS
                SELECT * FROM nrx_temp.ce_step2
                WHERE age_at_index >= 18
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step3_pid ON nrx_temp.ce_step3 (person_id)"
            )

        with self.db.transaction():
            step3_counts = self._count_by_arm("nrx_temp.ce_step3")
        results.append(self._step_row_from_prev(3, "Age ≥ 18", step3_counts, step2_counts))

        # ── Step 4: MDD diagnosis (F32.x or F33.x) on or before index ─
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step4")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step4 AS
                SELECT s.*
                FROM nrx_temp.ce_step3 s
                WHERE EXISTS (
                    SELECT 1
                    FROM analytics_omop.condition_occurrence co
                    WHERE co.person_id = s.person_id
                      AND (co._condition_concept_code LIKE 'F32%%'
                           OR co._condition_concept_code LIKE 'F33%%')
                      AND co.condition_start_date <= s.index_date
                )
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step4_pid ON nrx_temp.ce_step4 (person_id)"
            )

        with self.db.transaction():
            step4_counts = self._count_by_arm("nrx_temp.ce_step4")
        results.append(self._step_row_from_prev(4, "MDD diagnosis", step4_counts, step3_counts))

        # ── Step 5: Psychiatric exclusions ────────────────────────────
        # Exclude bipolar I/II and psychotic-spectrum diagnoses.
        # schizophrenia (F20.x), schizoaffective (F25.x),
        # other psychotic (F28, F29).
        psych_excl_sql = """
            (co._condition_concept_code LIKE 'F31%%'
             OR co._condition_concept_code LIKE 'F20%%'
             OR co._condition_concept_code LIKE 'F25%%'
             OR co._condition_concept_code LIKE 'F28%%'
             OR co._condition_concept_code LIKE 'F29%%')
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step5")
            self.db.execute(f"""
                CREATE TABLE nrx_temp.ce_step5 AS
                SELECT s.*
                FROM nrx_temp.ce_step4 s
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM analytics_omop.condition_occurrence co
                    WHERE co.person_id = s.person_id
                      AND {psych_excl_sql}
                )
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step5_pid ON nrx_temp.ce_step5 (person_id)"
            )
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_bipolar_routed")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_bipolar_routed AS
                SELECT DISTINCT s.person_id, s.treatment, s.index_date, s.age_at_index
                FROM nrx_temp.ce_step4 s
                JOIN analytics_omop.condition_occurrence co
                  ON co.person_id = s.person_id
                WHERE co._condition_concept_code LIKE 'F31%%'
                  AND s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step5)
            """)

        # Exclusion counts by diagnosis category
        with self.db.transaction():
            rows = self.db.select(f"""
                SELECT
                    CASE
                        WHEN co._condition_concept_code LIKE 'F31.81%%' THEN 'Bipolar II'
                        WHEN co._condition_concept_code = 'F31.9' THEN 'Bipolar unspecified'
                        WHEN co._condition_concept_code LIKE 'F31%%' THEN 'Bipolar I'
                        WHEN co._condition_concept_code LIKE 'F20%%' THEN 'Schizophrenia'
                        WHEN co._condition_concept_code LIKE 'F25%%' THEN 'Schizoaffective'
                        WHEN co._condition_concept_code LIKE 'F28%%'
                             OR co._condition_concept_code LIKE 'F29%%' THEN 'Other psychotic'
                    END AS category,
                    COUNT(DISTINCT s.person_id) AS n
                FROM nrx_temp.ce_step4 s
                JOIN analytics_omop.condition_occurrence co
                  ON co.person_id = s.person_id
                WHERE {psych_excl_sql}
                  AND s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step5)
                GROUP BY 1
                ORDER BY n DESC
            """)
        details["psych_exclusions"] = {r["category"]: r["n"] for r in rows if r["category"] is not None}

        with self.db.transaction():
            step5_counts = self._count_by_arm("nrx_temp.ce_step5")
        results.append(self._step_row_from_prev(5, "Psychiatric exclusions", step5_counts, step4_counts))

        # ── Step 5a: TRD ascertainment (informational; no exclusions) ─
        ad_clauses = " OR ".join(
            [f"de._drug_generic_concept_name ILIKE '%%{ad.lower()}%%'" for ad in ANTIDEPRESSANTS]
        )
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step5a_trd")
            self.db.execute(f"""
                CREATE TABLE nrx_temp.ce_step5a_trd AS
                WITH prior_ads AS (
                    SELECT s.person_id,
                           s.treatment,
                           COUNT(DISTINCT LOWER(BTRIM(de._drug_generic_concept_name))) AS n_distinct_ads
                    FROM nrx_temp.ce_step5 s
                    LEFT JOIN analytics_omop.drug_exposure de
                      ON de.person_id = s.person_id
                     AND de.drug_exposure_start_date < s.index_date
                     AND ({ad_clauses})
                    GROUP BY s.person_id, s.treatment
                )
                SELECT
                    person_id,
                    treatment,
                    n_distinct_ads,
                    CASE
                        WHEN n_distinct_ads >= 2 THEN 'TRD (>=2)'
                        WHEN n_distinct_ads = 1 THEN '1 prior AD'
                        ELSE '0 prior AD'
                    END AS trd_bucket,
                    (n_distinct_ads >= 2) AS trd_status
                FROM prior_ads
            """)
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_ce_step5a_trd_pid ON nrx_temp.ce_step5a_trd (person_id)")

        # TRD ascertainment rate
        with self.db.transaction():
            rows = self.db.select("""
                SELECT
                    treatment,
                    SUM(CASE WHEN n_distinct_ads >= 2 THEN 1 ELSE 0 END) AS n_trd_met,
                    SUM(CASE WHEN n_distinct_ads = 1 THEN 1 ELSE 0 END) AS n_one_ad,
                    SUM(CASE WHEN n_distinct_ads = 0 OR n_distinct_ads IS NULL THEN 1 ELSE 0 END) AS n_zero_ad,
                    COUNT(*) AS n_total
                FROM nrx_temp.ce_step5a_trd
                GROUP BY treatment
            """)
        trd_summary = {}
        for r in rows:
            trd_summary[r["treatment"]] = {
                "n_trd_met": r["n_trd_met"],
                "pct_trd_met": round(100 * r["n_trd_met"] / r["n_total"], 1) if r["n_total"] else 0.0,
                "n_one_ad": r["n_one_ad"],
                "pct_one_ad": round(100 * r["n_one_ad"] / r["n_total"], 1) if r["n_total"] else 0.0,
                "n_zero_ad": r["n_zero_ad"],
                "pct_zero_ad": round(100 * r["n_zero_ad"] / r["n_total"], 1) if r["n_total"] else 0.0,
            }
        details["trd_ascertainment_by_arm"] = trd_summary

        # ── Step 6: Baseline PHQ-9 (30 days before index) ────────────
        # Closest PHQ-9 in [index_date - 30, index_date)
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step6")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step6 AS
                WITH baseline_phq9 AS (
                    SELECT s.person_id,
                           m.value_as_number AS baseline_phq9,
                           m.measurement_date AS baseline_phq9_date,
                           (s.index_date - m.measurement_date) AS days_before_index,
                           ROW_NUMBER() OVER (
                               PARTITION BY s.person_id
                               ORDER BY m.measurement_date DESC
                           ) AS rn
                    FROM nrx_temp.ce_step5 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date >= s.index_date - 30
                      AND m.measurement_date < s.index_date
                )
                SELECT s.*, bp.baseline_phq9, bp.baseline_phq9_date
                FROM nrx_temp.ce_step5 s
                JOIN baseline_phq9 bp ON bp.person_id = s.person_id AND bp.rn = 1
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step6_pid ON nrx_temp.ce_step6 (person_id)"
            )

        with self.db.transaction():
            step6_counts = self._count_by_arm("nrx_temp.ce_step6")
        results.append(self._step_row_from_prev(6, "Baseline PHQ-9", step6_counts, step5_counts))

        # ── Step 7: Post-baseline PHQ-9 (index+1 through index+42) ───
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ce_step7")
            self.db.execute("""
                CREATE TABLE nrx_temp.ce_step7 AS
                SELECT s.*
                FROM nrx_temp.ce_step6 s
                WHERE EXISTS (
                    SELECT 1
                    FROM analytics_omop.measurement m
                    WHERE m.person_id = s.person_id
                      AND m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                )
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ce_step7_pid ON nrx_temp.ce_step7 (person_id)"
            )

        with self.db.transaction():
            step7_counts = self._count_by_arm("nrx_temp.ce_step7")
        results.append(self._step_row_from_prev(7, "Post-baseline PHQ-9", step7_counts, step6_counts))

        # ── Final summary ─────────────────────────────────────────────
        n_ket = step7_counts.get("Ketamine", 0)
        n_esk = step7_counts.get("Esketamine", 0)
        details["final_n_total"] = n_ket + n_esk
        details["final_n_ketamine"] = n_ket
        details["final_n_esketamine"] = n_esk
        details["arm_ratio"] = round(n_ket / n_esk, 2) if n_esk > 0 else None
        details["safety_analysis_set"] = {
            "n_total": step5_counts.get("Ketamine", 0) + step5_counts.get("Esketamine", 0),
            "n_ketamine": step5_counts.get("Ketamine", 0),
            "n_esketamine": step5_counts.get("Esketamine", 0),
        }

        summary_df = pd.DataFrame(results)

        # Save CSV
        summary_df.to_csv(TABDIR / "cohort_enumeration.csv", index=False)

        return summary_df, details

    def create_drug_exposure_table(self, lookup_timeout: int = 20) -> pd.DataFrame:
        """Create and enrich long-format drug exposures for first_exposure participants.

        Table shape: one row per person_id + drug_name + drug_exposure_start_date.
        Enrichment uses DrugLookup in bulk on unique drug names.
        """
        create_q = """
            CREATE TABLE nrx_temp.drug_exposure AS
            SELECT
                fe.person_id,
                de._drug_concept_name AS drug_name,
                de.drug_exposure_start_date,
                de.drug_exposure_end_date,
                NULL::BOOLEAN AS is_antidepressant,
                NULL::TEXT AS drug_class
            FROM nrx_temp.first_exposure fe
            JOIN analytics_omop.drug_exposure de
              ON de.person_id = fe.person_id
        """
        unique_drugs_q = """
            SELECT DISTINCT drug_name
            FROM nrx_temp.drug_exposure
            WHERE drug_name IS NOT NULL
              AND BTRIM(drug_name) <> ''
            ORDER BY drug_name
        """
        update_q = """
            UPDATE nrx_temp.drug_exposure
            SET is_antidepressant = %s,
                drug_class = %s
            WHERE LOWER(BTRIM(drug_name)) = LOWER(BTRIM(%s))
        """
        summary_q = """
            SELECT
                COUNT(*)::BIGINT AS n_rows,
                COUNT(DISTINCT person_id)::BIGINT AS n_people,
                COUNT(DISTINCT LOWER(BTRIM(drug_name)))::BIGINT AS n_unique_drugs,
                COUNT(*) FILTER (WHERE is_antidepressant IS TRUE)::BIGINT AS n_antidepressant_rows
            FROM nrx_temp.drug_exposure
        """

        with self.db.transaction():
            self.db.execute("CREATE SCHEMA IF NOT EXISTS nrx_temp")
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.drug_exposure")
            self.db.execute(create_q)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_drug_exposure_person_id ON nrx_temp.drug_exposure (person_id)"
            )
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_drug_exposure_drug_name ON nrx_temp.drug_exposure (drug_name)"
            )
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_drug_exposure_start_date ON nrx_temp.drug_exposure (drug_exposure_start_date)"
            )
            drug_rows = self.db.select(unique_drugs_q)

        unique_drug_names = [row["drug_name"] for row in drug_rows]
        lookup = DrugLookup()
        lookup_rows = lookup.bulk_antidepressant_lookup(unique_drug_names, timeout=lookup_timeout)
        update_params = [
            (bool(row["is_antidepressant"]), row["class_name"], row["drug"])
            for row in lookup_rows
            if row.get("drug")
        ]

        with self.db.transaction():
            if update_params:
                self.db.execute_many(update_q, update_params)
            rows = self.db.select(summary_q)
        return pd.DataFrame(rows)


    def create_outcome_table(
        self,
        measures: list[str],
        study_start: str = "2021-01-01",
        study_end: str = "2026-02-28",
        min_days: int = -14,
        max_days: int = 42,
    ) -> None:
        """Create nrx_temp.outcome table joining exposures to outcome measurements.

        Filters by study date range, patient age, and days from index date.
        """
        placeholders = ",".join(["%s"] * len(measures))
        q = f"""
            CREATE TABLE nrx_temp.outcome AS
            WITH params AS (
                SELECT
                    %s::DATE AS study_start_date,
                    %s::DATE AS study_end_date,
                    %s AS min_days,
                    %s AS max_days
            )
            SELECT
                fe.person_id,
                m.measurement_source_value AS measure,
                m.measurement_date AS outcome_date,
                m.value_as_number AS outcome_score,
                fe.index_date,
                (m.measurement_date - fe.index_date) AS days_from_index,
                fe.treatment AS treatment,
                DATE_PART('year', fe.index_date) - p.year_of_birth AS age_at_index
            FROM nrx_temp.first_exposure fe
            JOIN analytics_omop.measurement m ON m.person_id = fe.person_id
            JOIN analytics_omop.person p ON p.person_id = fe.person_id
            CROSS JOIN params
            WHERE TRUE
                AND m.measurement_source_value IN ({placeholders})
                AND fe.index_date >= params.study_start_date
                AND fe.index_date <= params.study_end_date
                AND m.measurement_date >= params.study_start_date
                AND m.measurement_date <= params.study_end_date
                AND (m.measurement_date - fe.index_date) BETWEEN params.min_days AND params.max_days
            ;
        """
        params = (study_start, study_end, min_days, max_days, *measures)

        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.outcome")
            self.db.execute(q, params)

        q = """
        SELECT treatment, 
               measure, 
               COUNT(DISTINCT(person_id)) AS num_participants, 
               COUNT(person_id) AS num_measures,
               MIN(outcome_date) AS start_outcome, 
               MAX(outcome_date) AS end_outcome
        FROM nrx_temp.outcome
        GROUP BY (treatment, measure)
        ORDER BY (measure, treatment)
        """
        with self.db.transaction():
            rows = self.db.select(q)
        return pd.DataFrame(rows) 

    # TODO: use source values and redo demographic cleaning 
    def create_participants_table(self) -> None:
        """Create participants with demographics, ZIP-linked income, and follow-up counts."""
        # Friendly preflight: participants now expects ZIP-income lookup to be
        # prepared explicitly (e.g., q.create_zip_income_table() in analysis.py).
        guard_q = """
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'nrx_temp'
                  AND table_name = 'zip_income_acs5'
            ) AS has_table
        """
        with self.db.transaction():
            guard_rows = self.db.select(guard_q)
        if not guard_rows or not bool(guard_rows[0]["has_table"]):
            raise ValueError(
                "Missing nrx_temp.zip_income_acs5. "
                "Please run create_zip_income_table() before create_participants_table()."
            )

        q = """
            CREATE TABLE nrx_temp.participants AS
            SELECT
                   o.person_id,
                   o.index_date,
                   o.treatment,
                   o.measure,
                   o.age_at_index,
                   pe.gender_source_value,
                   pe.race_source_value,
                   pe.ethnicity_source_value,
                   pe.location_id,
                   pe.care_site_id,
                   pe._source_created_at,
                   loc.zip,
                   z.median_income,
                   COUNT(*) FILTER (WHERE days_from_index < 0) AS num_baseline,
                   COUNT(*) FILTER (WHERE days_from_index > 0) AS num_followup
            FROM nrx_temp.outcome o
            JOIN analytics_omop.person pe
              ON pe.person_id = o.person_id
            LEFT JOIN analytics_omop.location loc
              ON loc.location_id = pe.location_id
            LEFT JOIN nrx_temp.zip_income_acs5 z
              ON LEFT(
                    regexp_replace(COALESCE(loc.zip::text, ''), '[^0-9]', '', 'g'),
                    5
                 ) = z.zip_code
            GROUP BY
                o.person_id,
                o.index_date,
                o.treatment,
                o.age_at_index,
                o.measure,
                pe.gender_source_value,
                pe.race_source_value,
                pe.ethnicity_source_value,
                pe.location_id,
                pe.care_site_id,
                pe._source_created_at,
                loc.zip,
                z.median_income
            ORDER BY o.person_id, o.treatment
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.participants")
            self.db.execute(q)
        
        q = "SELECT * FROM nrx_temp.participants LIMIT 5;"
        with self.db.transaction():
            rows = self.db.select(q)
        return pd.DataFrame(rows)

    def create_zip_income_table(self, year: int = 2023) -> pd.DataFrame:
        """Create/update local ZCTA median-income lookup table in nrx_temp.

        Guard behavior:
        - If table already has rows for only the requested year, skip refresh.
        - If empty or containing a different year, refresh from Census API.
        """
        create_q = """
            CREATE TABLE IF NOT EXISTS nrx_temp.zip_income_acs5 (
                zip_code TEXT PRIMARY KEY,
                zcta_name TEXT NOT NULL,
                median_income BIGINT NULL,
                census_year INTEGER NOT NULL,
                loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """
        truncate_q = "TRUNCATE TABLE nrx_temp.zip_income_acs5"
        insert_q = """
            INSERT INTO nrx_temp.zip_income_acs5
            (zip_code, zcta_name, median_income, census_year)
            VALUES (%s, %s, %s, %s)
        """
        existing_q = """
            SELECT census_year, COUNT(*)::BIGINT AS n
            FROM nrx_temp.zip_income_acs5
            GROUP BY census_year
            ORDER BY census_year
        """
        select_year_q = """
            SELECT zip_code, zcta_name, median_income, census_year
            FROM nrx_temp.zip_income_acs5
            WHERE census_year = %s
            ORDER BY zip_code
        """

        with self.db.transaction():
            self.db.execute("CREATE SCHEMA IF NOT EXISTS nrx_temp")
            self.db.execute(create_q)
            existing_rows = self.db.select(existing_q)

        # Idempotent guard: reuse local table when already populated for this year.
        if existing_rows:
            years_present = {int(row["census_year"]) for row in existing_rows}
            if years_present == {int(year)}:
                with self.db.transaction():
                    rows = self.db.select(select_year_q, (int(year),))
                return pd.DataFrame(rows)

        api_key = os.getenv("CENSUS_API_KEY")
        zip_income_df = fetch_all_zip_median_income(api_key=api_key, year=year)
        params = [
            (
                str(row.zip_code),
                str(row.zcta_name),
                None if pd.isna(row.median_income) else int(row.median_income),
                int(row.census_year),
            )
            for row in zip_income_df.itertuples(index=False)
        ]

        with self.db.transaction():
            self.db.execute(truncate_q)
            self.db.execute_many(insert_q, params)

        return zip_income_df

    # TODO: also get single-item SI questions from PHQ-9, MADRS, etc.
    def create_si_table(self) -> pd.DataFrame:
        """Create nrx_temp.si table with suicidal-ideation observations for participants."""
        q = """
            CREATE TABLE nrx_temp.si AS
            SELECT
                p.person_id,
                o.observation_date,
                o.observation_source_value,
                o.visit_occurrence_id,
                o.value_source_value
            FROM analytics_omop.observation o
            JOIN nrx_temp.participants p ON o.person_id = p.person_id
            WHERE o.observation_source_value IN (
                'patient_denies_suicidal_ideation',
                'suicidal_details',
                'suicidal_frequency',
                'suicidal_ideation',
                'suicidal_intent',
                'suicidal_plan'
            )
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.si")
            self.db.execute(q)
            rows = self.db.select(
                """
                SELECT
                    p.treatment,
                    COUNT(DISTINCT s.person_id) AS n_unique_person_ids
                FROM nrx_temp.si s
                JOIN nrx_temp.participants p
                  ON p.person_id = s.person_id
                GROUP BY p.treatment
                ORDER BY p.treatment
                """
            )
        return pd.DataFrame(rows)


    def consort_diagram_counts(
        self,
        outcomes: list[str] | None = None,
        min_age: int = 18,
        max_age: int | None = 95,
    ) -> pd.DataFrame:
        """Get participant counts at each consort diagram stage, by treatment.

        Returns DataFrame with columns: treatment, ntot, nage, nmdd,
        noutcome_baseline, noutcome_followup.
        Requires nrx_temp.first_exposure, outcomes, and participants to exist.
        """
        outcome_filter = ""
        max_age_filter = ""
        if outcomes:
            placeholders = ",".join(["%s"] * len(outcomes))
            outcome_filter = f"AND p.measure IN ({placeholders})"
        if max_age is not None:
            max_age_filter = "AND pa.age_at_index <= %s"

        # Duplicate outcome params for both baseline and followup CTEs
        outcome_params = list(outcomes) if outcomes else []

        q = f"""
            WITH plausible_age AS (
                SELECT fe.person_id, fe.treatment
                     , DATE_PART('year', fe.index_date) - pe.year_of_birth AS age_at_index
                FROM nrx_temp.first_exposure fe
                JOIN analytics_omop.person pe ON pe.person_id = fe.person_id
                WHERE DATE_PART('year', fe.index_date) - pe.year_of_birth > 1
                  AND DATE_PART('year', fe.index_date) - pe.year_of_birth <= 95
            ),
            total AS (
                SELECT treatment, COUNT(DISTINCT person_id) AS n
                FROM plausible_age
                GROUP BY treatment
            ),
            eligible_age AS (
                SELECT pa.person_id, pa.treatment
                FROM plausible_age pa
                WHERE pa.age_at_index >= %s
                {max_age_filter}
            ),
            age_filtered AS (
                SELECT treatment, COUNT(DISTINCT person_id) AS n
                FROM eligible_age
                GROUP BY treatment
            ),
            eligible_mdd AS (
                SELECT ea.person_id, ea.treatment
                FROM eligible_age ea
                WHERE EXISTS (
                    SELECT 1
                    FROM analytics_omop.condition_occurrence co
                    WHERE co.person_id = ea.person_id
                      AND (
                        co._condition_concept_code LIKE 'F32%%'
                        OR co._condition_concept_code LIKE 'F33%%'
                      )
                )
            ),
            mdd_filtered AS (
                SELECT treatment, COUNT(DISTINCT person_id) AS n
                FROM eligible_mdd
                GROUP BY treatment
            ),
            eligible_baseline AS (
                SELECT em.person_id, em.treatment
                FROM eligible_mdd em
                JOIN nrx_temp.participants p
                  ON p.person_id = em.person_id
                 AND p.treatment = em.treatment
                WHERE p.num_baseline >= 1
                  {outcome_filter}
            ),
            baseline AS (
                SELECT treatment, COUNT(DISTINCT person_id) AS n
                FROM eligible_baseline
                GROUP BY treatment
            ),
            eligible_followup AS (
                SELECT eb.person_id, eb.treatment
                FROM eligible_baseline eb
                JOIN nrx_temp.participants p
                  ON p.person_id = eb.person_id
                 AND p.treatment = eb.treatment
                WHERE p.num_baseline >= 1
                  AND p.num_followup >= 1
                  {outcome_filter}
            ),
            followup AS (
                SELECT treatment, COUNT(DISTINCT person_id) AS n
                FROM eligible_followup
                GROUP BY treatment
            )
            SELECT
                t.treatment,
                t.n AS ntot,
                a.n AS nage,
                m.n AS nmdd,
                b.n AS noutcome_baseline,
                f.n AS noutcome_followup
            FROM total t
            LEFT JOIN age_filtered a ON a.treatment = t.treatment
            LEFT JOIN mdd_filtered m ON m.treatment = t.treatment
            LEFT JOIN baseline b ON b.treatment = t.treatment
            LEFT JOIN followup f ON f.treatment = t.treatment
            ORDER BY t.treatment
        """
        all_params = [min_age]
        if max_age is not None:
            all_params.append(max_age)
        all_params = all_params + outcome_params + outcome_params
        with self.db.transaction():
            rows = self.db.select(q, tuple(all_params))
        return pd.DataFrame(rows)

    def get_sample_for_analysis(
        self,
        outcomes: list[str] | None = None,
        min_age: int = 18,
        max_age: int | None = None,
    ) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Create final analysis sample table and return outcomes + demographics.

        Returns:
            sample_df: Rows from nrx_temp.analysis_sample_final.
            demographics_df: Participant-level demographics for people in the final sample.
        """
        outcome_filter = ""
        max_age_filter = ""
        params: list = [min_age]
        if max_age is not None:
            max_age_filter = "AND p.age_at_index <= %s"
            params.append(max_age)
        if outcomes:
            placeholders = ",".join(["%s"] * len(outcomes))
            outcome_filter = f"AND o.measure IN ({placeholders})"
            params.extend(outcomes)

        create_q = f"""
            CREATE TABLE nrx_temp.analysis_sample_final AS
            SELECT
                o.person_id,
                o.index_date,
                o.treatment,
                o.measure,
                o.outcome_score,
                o.days_from_index
            FROM nrx_temp.outcome o
            JOIN nrx_temp.participants p
              ON o.person_id = p.person_id
             AND o.treatment = p.treatment
             AND o.measure = p.measure
            WHERE p.age_at_index >= %s
              AND p.num_baseline >= 1
              AND p.num_followup >= 1
              AND EXISTS (
                    SELECT 1
                    FROM analytics_omop.condition_occurrence co
                    WHERE co.person_id = o.person_id
                      AND (
                        co._condition_concept_code LIKE 'F32%%'
                        OR co._condition_concept_code LIKE 'F33%%'
                      )
                )
              {max_age_filter}
              {outcome_filter}
            ORDER BY o.person_id, o.measure, o.days_from_index
        """
        sample_q = """
            SELECT person_id, index_date, treatment, measure, outcome_score, days_from_index
            FROM nrx_temp.analysis_sample_final
            ORDER BY person_id, measure, days_from_index
        """
        demographics_q = """
            SELECT DISTINCT
                p.person_id,
                p.treatment,
                p.age_at_index AS age,
                p.median_income,
                p.gender_source_value AS gender,
                p.race_source_value AS race,
                p.ethnicity_source_value AS ethnicity
            FROM nrx_temp.participants p
            JOIN (
                SELECT DISTINCT person_id, treatment
                FROM nrx_temp.analysis_sample_final
            ) s
              ON s.person_id = p.person_id
             AND s.treatment = p.treatment
            WHERE p.age_at_index IS NOT NULL
            ORDER BY p.person_id, p.treatment
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.analysis_sample_final")
            self.db.execute(create_q, tuple(params))
            sample_rows = self.db.select(sample_q)
            demographics_rows = self.db.select(demographics_q)
        return pd.DataFrame(sample_rows), pd.DataFrame(demographics_rows)

    # ------------------------------------------------------------------
    # Propensity Score Feasibility
    # ------------------------------------------------------------------

    def _build_ps_covariates(self) -> pd.DataFrame:
        """Create nrx_temp.ps_covariates from ce_step7 + demographics + income.

        Requires nrx_temp.ce_step7 and nrx_temp.zip_income_acs5 to exist.
        Builds two intermediate temp tables to avoid LATERAL-join timeouts,
        then assembles the final covariate table.
        Returns the covariates DataFrame.
        """
        ad_clauses = " OR ".join(
            [f"de._drug_generic_concept_name ILIKE '%%{ad.lower()}%%'" for ad in ANTIDEPRESSANTS]
        )

        # Step A: PHQ-9 Item 9 at baseline date
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp._ps_item9")
            self.db.execute("""
                CREATE TABLE nrx_temp._ps_item9 AS
                WITH ranked AS (
                    SELECT
                        s.person_id,
                        m.value_as_number AS baseline_phq9_item9,
                        ROW_NUMBER() OVER (PARTITION BY s.person_id ORDER BY m.measurement_date DESC) AS rn
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                     AND m.measurement_date = s.baseline_phq9_date
                     AND m.measurement_source_value = 'Over the past two weeks: Thoughts that you would be better off dead, or of hurting yourself in some way?'
                )
                SELECT person_id, baseline_phq9_item9
                FROM ranked WHERE rn = 1
            """)
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_ps_item9_pid ON nrx_temp._ps_item9 (person_id)")

        # Step B: Concurrent oral antidepressant at baseline
        concurrent_ad_q = f"""
            CREATE TABLE nrx_temp._ps_concurrent_ad AS
            SELECT DISTINCT s.person_id, TRUE AS concurrent_oral_ad_at_baseline
            FROM nrx_temp.ce_step7 s
            JOIN analytics_omop.drug_exposure de
              ON de.person_id = s.person_id
            WHERE de.drug_exposure_start_date <= s.index_date
              AND (de.drug_exposure_end_date IS NULL OR de.drug_exposure_end_date >= s.index_date)
              AND ({ad_clauses})
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp._ps_concurrent_ad")
            self.db.execute(concurrent_ad_q)
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_ps_cad_pid ON nrx_temp._ps_concurrent_ad (person_id)")

        # Step C: Assemble final covariates
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ps_covariates")
            self.db.execute("""
                CREATE TABLE nrx_temp.ps_covariates AS
                SELECT
                    s.person_id,
                    s.treatment,
                    s.index_date,
                    s.age_at_index,
                    s.baseline_phq9,
                    i9.baseline_phq9_item9,
                    p.gender_source_value AS gender,
                    p.race_source_value AS race,
                    p.ethnicity_source_value AS ethnicity,
                    z.median_income,
                    COALESCE(trd.trd_status, FALSE) AS trd_status,
                    COALESCE(cad.concurrent_oral_ad_at_baseline, FALSE) AS concurrent_oral_ad_at_baseline
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.person p ON p.person_id = s.person_id
                LEFT JOIN analytics_omop.location loc ON loc.location_id = p.location_id
                LEFT JOIN nrx_temp.zip_income_acs5 z
                  ON LEFT(
                        regexp_replace(COALESCE(loc.zip::text, ''), '[^0-9]', '', 'g'),
                        5
                     ) = z.zip_code
                LEFT JOIN nrx_temp.ce_step5a_trd trd
                  ON trd.person_id = s.person_id
                LEFT JOIN nrx_temp._ps_item9 i9
                  ON i9.person_id = s.person_id
                LEFT JOIN nrx_temp._ps_concurrent_ad cad
                  ON cad.person_id = s.person_id
            """)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ps_cov_pid ON nrx_temp.ps_covariates (person_id)"
            )
            rows = self.db.select("SELECT * FROM nrx_temp.ps_covariates")
        df = pd.DataFrame(rows)
        df = clean_demographics(df)
        df["depression_severity"] = np.where(
            df["baseline_phq9"] >= 20, "Severe",
            np.where(df["baseline_phq9"] >= 15, "Moderately severe",
                     np.where(df["baseline_phq9"] >= 10, "Moderate", "Below moderate"))
        )
        df["suicidal_ideation_baseline"] = np.where(
            df["baseline_phq9_item9"] >= 2,
            "PHQ-9 Item 9 >=2",
            "PHQ-9 Item 9 <2",
        )
        return df

    def _build_ps_extended_covariates(self) -> pd.DataFrame:
        """Create nrx_temp.ps_extended_covariates from ce_step7 + clinical data."""
        medication_classes = {
            "ssri": ["sertraline", "fluoxetine", "escitalopram", "paroxetine", "citalopram"],
            "snri": ["venlafaxine", "duloxetine", "desvenlafaxine", "levomilnacipran"],
            "tca": ["amitriptyline", "nortriptyline", "imipramine", "desipramine"],
            "maoi": ["phenelzine", "tranylcypromine", "selegiline", "isocarboxazid"],
            "other_ad": ["bupropion", "mirtazapine", "trazodone", "vilazodone", "vortioxetine"],
            "benzodiazepine": ["alprazolam", "clonazepam", "lorazepam", "diazepam"],
            "mood_stabilizer": ["lithium", "valproate", "lamotrigine", "carbamazepine"],
            "antipsychotic": ["aripiprazole", "quetiapine", "olanzapine", "risperidone", "brexpiprazole"],
            "stimulant": ["methylphenidate", "amphetamine", "lisdexamfetamine"],
        }
        class_sql_parts = []
        for class_name, meds in medication_classes.items():
            med_clause = " OR ".join(
                [f"de._drug_generic_concept_name ILIKE '%%{med.lower()}%%'" for med in meds]
            )
            class_sql_parts.append(
                f"""MAX(CASE WHEN ({med_clause})
                         AND de.drug_exposure_start_date <= s.index_date
                         AND (de.drug_exposure_end_date IS NULL OR de.drug_exposure_end_date >= s.index_date)
                         THEN 1 ELSE 0 END)::BOOLEAN AS has_{class_name}"""
            )
        class_sql = ",\n                       ".join(class_sql_parts)
        ad_clauses = " OR ".join(
            [f"de._drug_generic_concept_name ILIKE '%%{ad.lower()}%%'" for ad in ANTIDEPRESSANTS]
        )
        q = f"""
            CREATE TABLE nrx_temp.ps_extended_covariates AS
            WITH prior_ads AS (
                SELECT s.person_id,
                       COUNT(DISTINCT LOWER(BTRIM(de._drug_generic_concept_name))) AS n_prior_ads
                FROM nrx_temp.ce_step7 s
                LEFT JOIN analytics_omop.drug_exposure de
                  ON de.person_id = s.person_id
                 AND de.drug_exposure_start_date < s.index_date
                 AND ({ad_clauses})
                GROUP BY s.person_id
            ),
            anxiety AS (
                SELECT DISTINCT s.person_id, TRUE AS comorbid_anxiety
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.condition_occurrence co
                  ON co.person_id = s.person_id
                WHERE (co._condition_concept_code LIKE 'F40%%'
                       OR co._condition_concept_code LIKE 'F41%%')
            ),
            ptsd AS (
                SELECT DISTINCT s.person_id, TRUE AS comorbid_ptsd
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.condition_occurrence co
                  ON co.person_id = s.person_id
                WHERE co._condition_concept_code LIKE 'F43.1%%'
            ),
            sud AS (
                SELECT DISTINCT s.person_id, TRUE AS sud_history
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.condition_occurrence co
                  ON co.person_id = s.person_id
                WHERE co._condition_concept_code ~ '^F1[0-9]'
            ),
            med_classes AS (
                SELECT
                    s.person_id,
                    s.treatment,
                    {class_sql}
                FROM nrx_temp.ce_step7 s
                LEFT JOIN analytics_omop.drug_exposure de ON de.person_id = s.person_id
                GROUP BY s.person_id, s.treatment
            )
            SELECT
                s.person_id,
                s.treatment,
                COALESCE(pa.n_prior_ads, 0) AS n_prior_ads,
                CASE
                    WHEN COALESCE(pa.n_prior_ads, 0) >= 4 THEN '4+'
                    ELSE COALESCE(pa.n_prior_ads, 0)::TEXT
                END AS n_prior_ads_category,
                COALESCE(anx.comorbid_anxiety, FALSE) AS comorbid_anxiety,
                COALESCE(pt.comorbid_ptsd, FALSE) AS comorbid_ptsd,
                EXTRACT(YEAR FROM s.index_date)::INT AS index_year,
                COALESCE(su.sud_history, FALSE) AS sud_history,
                mc.has_ssri,
                mc.has_snri,
                mc.has_tca,
                mc.has_maoi,
                mc.has_other_ad,
                mc.has_benzodiazepine,
                mc.has_mood_stabilizer,
                mc.has_antipsychotic,
                mc.has_stimulant,
                (
                    COALESCE(mc.has_ssri::INT, 0) +
                    COALESCE(mc.has_snri::INT, 0) +
                    COALESCE(mc.has_tca::INT, 0) +
                    COALESCE(mc.has_maoi::INT, 0) +
                    COALESCE(mc.has_other_ad::INT, 0) +
                    COALESCE(mc.has_benzodiazepine::INT, 0) +
                    COALESCE(mc.has_mood_stabilizer::INT, 0) +
                    COALESCE(mc.has_antipsychotic::INT, 0) +
                    COALESCE(mc.has_stimulant::INT, 0)
                ) AS n_concurrent_psychotropic_classes
            FROM nrx_temp.ce_step7 s
            LEFT JOIN prior_ads pa ON pa.person_id = s.person_id
            LEFT JOIN anxiety anx ON anx.person_id = s.person_id
            LEFT JOIN ptsd pt ON pt.person_id = s.person_id
            LEFT JOIN sud su ON su.person_id = s.person_id
            LEFT JOIN med_classes mc ON mc.person_id = s.person_id
        """
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.ps_extended_covariates")
            self.db.execute(q)
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS idx_ps_ext_pid ON nrx_temp.ps_extended_covariates (person_id)"
            )
            rows = self.db.select("SELECT * FROM nrx_temp.ps_extended_covariates")
        return pd.DataFrame(rows)

    @staticmethod
    def _smd_continuous(s1: pd.Series, s2: pd.Series) -> float:
        """Standardized mean difference for a continuous variable."""
        m1, m2 = s1.mean(), s2.mean()
        sd1, sd2 = s1.std(), s2.std()
        denom = np.sqrt((sd1**2 + sd2**2) / 2)
        return float((m1 - m2) / denom) if denom > 0 else 0.0

    @staticmethod
    def _smd_categorical(s1: pd.Series, s2: pd.Series) -> float:
        """Standardized mean difference for a categorical variable.

        Uses the Mahalanobis-style formula across all category proportions.
        """
        cats = sorted(set(s1.dropna().unique()) | set(s2.dropna().unique()))
        if len(cats) <= 1:
            return 0.0
        p1 = s1.value_counts(normalize=True).reindex(cats, fill_value=0.0)
        p2 = s2.value_counts(normalize=True).reindex(cats, fill_value=0.0)
        # Drop last category (linearly dependent)
        p1 = p1.iloc[:-1].values
        p2 = p2.iloc[:-1].values
        diff = p1 - p2
        # Average covariance matrix (diagonal approximation)
        s_avg = (np.diag(p1 * (1 - p1)) + np.diag(p2 * (1 - p2))) / 2
        det = np.linalg.det(s_avg)
        if det <= 0:
            return float(np.sqrt(np.sum(diff**2)))
        s_inv = np.linalg.inv(s_avg)
        return float(np.sqrt(diff @ s_inv @ diff))

    def run_propensity_score_feasibility(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """Run the full propensity score feasibility analysis per the spec.

        Requires nrx_temp.ce_step7 and nrx_temp.zip_income_acs5 to exist
        (i.e., run_cohort_enumeration() and create_zip_income_table() first).

        Returns:
            completeness_df: Covariate completeness by arm.
            distributions_df: Descriptive statistics + SMD by arm.
            extended_df: Extended covariate availability by arm.
            meds_df: Baseline concomitant medication class frequencies by arm.
        """
        # --- 1. Build covariate tables ---
        cov_df = self._build_ps_covariates()
        ext_df = self._build_ps_extended_covariates()

        arms = ["Ketamine", "Esketamine"]

        # --- 2. Covariate Completeness ---
        covariates = {
            "Baseline PHQ-9": "baseline_phq9",
            "Baseline PHQ-9 Item 9": "baseline_phq9_item9",
            "Age": "age_at_index",
            "Gender": "gender",
            "Race": "race",
            "Ethnicity": "ethnicity",
            "Median household income": "median_income",
            "TRD status": "trd_status",
            "Concurrent oral antidepressant at baseline": "concurrent_oral_ad_at_baseline",
        }
        completeness_rows = []
        for label, col in covariates.items():
            for arm in arms:
                arm_data = cov_df.loc[cov_df["treatment"] == arm, col]
                n_total = len(arm_data)
                n_non_missing = arm_data.notna().sum()
                n_missing = n_total - n_non_missing
                pct_non_missing = round(100 * n_non_missing / n_total, 1) if n_total > 0 else 0.0
                completeness_rows.append({
                    "covariate": label,
                    "arm": arm,
                    "n_total": n_total,
                    "n_non_missing": int(n_non_missing),
                    "pct_non_missing": pct_non_missing,
                    "n_missing": int(n_missing),
                    "flag_gt20pct_missing": pct_non_missing < 80,
                })
        completeness_df = pd.DataFrame(completeness_rows)

        # --- 3. Covariate Distributions + SMD ---
        continuous_vars = {
            "Baseline PHQ-9": "baseline_phq9",
            "Baseline PHQ-9 Item 9": "baseline_phq9_item9",
            "Age": "age_at_index",
            "Median household income": "median_income",
        }
        categorical_vars = {
            "Gender": "gender",
            "Race": "race",
            "Ethnicity": "ethnicity",
            "TRD status": "trd_status",
            "Concurrent oral antidepressant at baseline": "concurrent_oral_ad_at_baseline",
            "Depression severity": "depression_severity",
            "Suicidal ideation at baseline": "suicidal_ideation_baseline",
        }

        dist_rows = []
        # Continuous
        for label, col in continuous_vars.items():
            for arm in arms:
                vals = cov_df.loc[cov_df["treatment"] == arm, col].dropna()
                dist_rows.append({
                    "covariate": label,
                    "category": None,
                    "arm": arm,
                    "n": len(vals),
                    "mean": round(vals.mean(), 2) if len(vals) > 0 else None,
                    "sd": round(vals.std(), 2) if len(vals) > 0 else None,
                    "median": round(vals.median(), 2) if len(vals) > 0 else None,
                    "q1": round(vals.quantile(0.25), 2) if len(vals) > 0 else None,
                    "q3": round(vals.quantile(0.75), 2) if len(vals) > 0 else None,
                    "min": round(vals.min(), 2) if len(vals) > 0 else None,
                    "max": round(vals.max(), 2) if len(vals) > 0 else None,
                    "freq": None,
                    "pct": None,
                })
            # SMD
            s1 = cov_df.loc[cov_df["treatment"] == arms[0], col].dropna()
            s2 = cov_df.loc[cov_df["treatment"] == arms[1], col].dropna()
            smd = self._smd_continuous(s1, s2)
            dist_rows[-2]["smd"] = round(smd, 3)
            dist_rows[-1]["smd"] = round(smd, 3)

        # Categorical
        for label, col in categorical_vars.items():
            categories = sorted(cov_df[col].dropna().unique())
            s1 = cov_df.loc[cov_df["treatment"] == arms[0], col].dropna()
            s2 = cov_df.loc[cov_df["treatment"] == arms[1], col].dropna()
            smd = self._smd_categorical(s1, s2)
            for cat in categories:
                for arm in arms:
                    arm_data = cov_df.loc[cov_df["treatment"] == arm, col]
                    n_arm = len(arm_data.dropna())
                    freq = int((arm_data == cat).sum())
                    pct = round(100 * freq / n_arm, 1) if n_arm > 0 else 0.0
                    dist_rows.append({
                        "covariate": label,
                        "category": cat,
                        "arm": arm,
                        "n": n_arm,
                        "mean": None, "sd": None, "median": None,
                        "q1": None, "q3": None, "min": None, "max": None,
                        "freq": freq,
                        "pct": pct,
                        "smd": round(smd, 3),
                    })

        distributions_df = pd.DataFrame(dist_rows)

        # --- 4. Extended Covariates Availability ---
        extended_vars = {
            "Number of prior AD trials": ("n_prior_ads_category", "categorical"),
            "Comorbid anxiety disorder": ("comorbid_anxiety", "boolean"),
            "Comorbid PTSD": ("comorbid_ptsd", "boolean"),
            "Year of index treatment": ("index_year", "continuous"),
            "Substance use disorder history": ("sud_history", "boolean"),
            "Concurrent psychotropic medication classes (count)": ("n_concurrent_psychotropic_classes", "continuous"),
        }
        ext_rows = []
        for label, (col, vtype) in extended_vars.items():
            for arm in arms:
                arm_data = ext_df.loc[ext_df["treatment"] == arm, col]
                n_total = len(arm_data)
                n_non_missing = arm_data.notna().sum()
                n_missing = n_total - n_non_missing
                pct_non_missing = round(100 * n_non_missing / n_total, 1) if n_total > 0 else 0.0

                row = {
                    "covariate": label,
                    "arm": arm,
                    "n_total": n_total,
                    "n_non_missing": int(n_non_missing),
                    "pct_non_missing": pct_non_missing,
                    "n_missing": int(n_missing),
                }
                if vtype == "boolean":
                    n_true = int(arm_data.sum()) if n_non_missing > 0 else 0
                    row["n_positive"] = n_true
                    row["pct_positive"] = round(100 * n_true / n_total, 1) if n_total > 0 else 0.0
                elif vtype == "categorical":
                    row["distribution"] = arm_data.value_counts(dropna=False).to_dict()
                ext_rows.append(row)

        extended_df = pd.DataFrame(ext_rows)

        # --- 5. Concomitant medication classes at baseline (2d) ---
        med_cols = [
            ("SSRI", "has_ssri"),
            ("SNRI", "has_snri"),
            ("TCA", "has_tca"),
            ("MAOI", "has_maoi"),
            ("Other antidepressants", "has_other_ad"),
            ("Benzodiazepines", "has_benzodiazepine"),
            ("Mood stabilizers / anticonvulsants", "has_mood_stabilizer"),
            ("Antipsychotics", "has_antipsychotic"),
            ("Stimulants", "has_stimulant"),
        ]
        meds_rows = []
        for med_label, med_col in med_cols:
            for arm in arms:
                arm_data = ext_df.loc[ext_df["treatment"] == arm, med_col]
                n_total = len(arm_data)
                n_present = int(arm_data.sum()) if n_total else 0
                meds_rows.append({
                    "medication_class": med_label,
                    "arm": arm,
                    "n": n_present,
                    "pct": round(100 * n_present / n_total, 1) if n_total else 0.0,
                })
        for arm in arms:
            base = cov_df.loc[cov_df["treatment"] == arm, "concurrent_oral_ad_at_baseline"]
            n_total = len(base)
            n_present = int(base.sum()) if n_total else 0
            meds_rows.append({
                "medication_class": "Any oral antidepressant",
                "arm": arm,
                "n": n_present,
                "pct": round(100 * n_present / n_total, 1) if n_total else 0.0,
            })
            class_counts = ext_df.loc[ext_df["treatment"] == arm, "n_concurrent_psychotropic_classes"]
            for bucket, mask in [
                ("0", class_counts == 0),
                ("1", class_counts == 1),
                ("2", class_counts == 2),
                ("3+", class_counts >= 3),
            ]:
                n_bucket = int(mask.sum())
                meds_rows.append({
                    "medication_class": f"Concurrent psychotropic classes: {bucket}",
                    "arm": arm,
                    "n": n_bucket,
                    "pct": round(100 * n_bucket / len(class_counts), 1) if len(class_counts) else 0.0,
                })
        meds_df = pd.DataFrame(meds_rows)

        # --- 6. Save CSVs ---
        completeness_df.to_csv(TABDIR / "ps_covariate_completeness.csv", index=False)
        distributions_df.to_csv(TABDIR / "ps_covariate_distributions.csv", index=False)
        extended_df.to_csv(TABDIR / "ps_extended_covariates.csv", index=False)
        meds_df.to_csv(TABDIR / "ps_concomitant_medications.csv", index=False)
        # Individual-level covariates for R power analysis (propensity score + IPTW)
        cov_df.to_csv(TABDIR / "ps_covariates_individual.csv", index=False)

        return completeness_df, distributions_df, extended_df, meds_df

    def run_assessment_density(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """Section 3 outputs for the eligible analytic cohort (ce_step7)."""
        with self.db.transaction():
            count_rows = self.db.select("""
                WITH post_counts AS (
                    SELECT s.person_id,
                           s.treatment,
                           COUNT(*) AS n_post
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                    GROUP BY s.person_id, s.treatment
                )
                SELECT
                    treatment,
                    CASE
                        WHEN n_post >= 5 THEN '5+'
                        ELSE n_post::TEXT
                    END AS post_phq9_count_bucket,
                    COUNT(*) AS n_patients
                FROM post_counts
                GROUP BY treatment, post_phq9_count_bucket
                ORDER BY treatment, post_phq9_count_bucket
            """)
            timing_rows = self.db.select("""
                SELECT
                    s.treatment,
                    COUNT(*) AS n_assessments,
                    AVG((m.measurement_date - s.index_date)::INT) AS mean_days,
                    STDDEV((m.measurement_date - s.index_date)::INT) AS sd_days,
                    MIN((m.measurement_date - s.index_date)::INT) AS min_days,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY (m.measurement_date - s.index_date)::INT) AS q1_days,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (m.measurement_date - s.index_date)::INT) AS median_days,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY (m.measurement_date - s.index_date)::INT) AS q3_days,
                    MAX((m.measurement_date - s.index_date)::INT) AS max_days
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.measurement m
                  ON m.person_id = s.person_id
                WHERE m.measurement_source_value = 'PHQ-9'
                  AND m.measurement_date > s.index_date
                  AND m.measurement_date <= s.index_date + 42
                GROUP BY s.treatment
                ORDER BY s.treatment
            """)
            alt_rows = self.db.select("""
                WITH no_baseline AS (
                    SELECT s.*
                    FROM nrx_temp.ce_step5 s
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step6)
                ),
                no_post AS (
                    SELECT s.*
                    FROM nrx_temp.ce_step6 s
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step7)
                )
                SELECT
                    grp,
                    instrument,
                    treatment,
                    COUNT(DISTINCT person_id) AS n_patients
                FROM (
                    SELECT
                        'Excluded at Step 6 (no baseline PHQ-9)' AS grp,
                        CASE
                            WHEN m.measurement_source_value ILIKE '%MADRS%' THEN 'MADRS'
                            WHEN m.measurement_source_value ILIKE '%QIDS%' THEN 'QIDS'
                            WHEN m.measurement_source_value ILIKE '%HAM-D%' OR m.measurement_source_value ILIKE '%HAMD%' THEN 'HAM-D'
                        END AS instrument,
                        b.treatment,
                        b.person_id
                    FROM no_baseline b
                    JOIN analytics_omop.measurement m
                      ON m.person_id = b.person_id
                    WHERE m.measurement_date >= b.index_date - 30
                      AND m.measurement_date < b.index_date
                      AND (
                        m.measurement_source_value ILIKE '%MADRS%'
                        OR m.measurement_source_value ILIKE '%QIDS%'
                        OR m.measurement_source_value ILIKE '%HAM-D%'
                        OR m.measurement_source_value ILIKE '%HAMD%'
                      )
                    UNION ALL
                    SELECT
                        'Excluded at Step 7 (no post-baseline PHQ-9)' AS grp,
                        CASE
                            WHEN m.measurement_source_value ILIKE '%MADRS%' THEN 'MADRS'
                            WHEN m.measurement_source_value ILIKE '%QIDS%' THEN 'QIDS'
                            WHEN m.measurement_source_value ILIKE '%HAM-D%' OR m.measurement_source_value ILIKE '%HAMD%' THEN 'HAM-D'
                        END AS instrument,
                        p.treatment,
                        p.person_id
                    FROM no_post p
                    JOIN analytics_omop.measurement m
                      ON m.person_id = p.person_id
                    WHERE m.measurement_date > p.index_date
                      AND m.measurement_date <= p.index_date + 42
                      AND (
                        m.measurement_source_value ILIKE '%MADRS%'
                        OR m.measurement_source_value ILIKE '%QIDS%'
                        OR m.measurement_source_value ILIKE '%HAM-D%'
                        OR m.measurement_source_value ILIKE '%HAMD%'
                      )
                ) t
                WHERE instrument IS NOT NULL
                GROUP BY grp, instrument, treatment
                ORDER BY grp, instrument, treatment
            """)
        return pd.DataFrame(count_rows), pd.DataFrame(timing_rows), pd.DataFrame(alt_rows)

    def run_subgroup_cell_sizes(self) -> pd.DataFrame:
        """Section 4 subgroup cell sizes for ce_step7."""
        cov_df = self._build_ps_covariates()
        rows = []
        for _, r in cov_df.iterrows():
            age_group = "18-34" if r["age_at_index"] < 35 else ("35-54" if r["age_at_index"] < 55 else ">=55")
            era = "Before Jan 2025" if pd.Timestamp(r["index_date"]) < pd.Timestamp("2025-01-01") else "On/after Jan 2025"
            rows.extend([
                ("TRD status", "TRD" if bool(r["trd_status"]) else "Non-TRD", r["treatment"]),
                ("Concurrent oral antidepressant at baseline", "Yes" if bool(r["concurrent_oral_ad_at_baseline"]) else "No", r["treatment"]),
                ("Baseline depression severity", r["depression_severity"], r["treatment"]),
                ("Baseline suicidal ideation", ">=2" if r["baseline_phq9_item9"] >= 2 else "<2", r["treatment"]),
                ("Age group", age_group, r["treatment"]),
                ("Sex", r["gender"], r["treatment"]),
                ("Treatment setting era", era, r["treatment"]),
            ])
        subgroup_df = pd.DataFrame(rows, columns=["subgroup", "category", "arm"])
        out = (
            subgroup_df
            .groupby(["subgroup", "category", "arm"], as_index=False)
            .size()
            .rename(columns={"size": "n"})
        )
        out["flag_lt30"] = out["n"] < 30
        out.to_csv(TABDIR / "subgroup_cell_sizes.csv", index=False)
        return out

    def run_supplementary_tables(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Section 5 supplementary tables.

        Returns:
            attrition_df: 5b attrition comparison (retained vs excluded at each step).
            dual_exposure_df: 5c dual-exposed patient details.
        """
        with self.db.transaction():
            # 5b: Attrition comparison with demographics
            attrition_rows = self.db.select("""
                WITH unioned AS (
                    SELECT 'Step 4' AS step_name, 'Retained' AS status, s.person_id, s.treatment, s.age_at_index, NULL::DOUBLE PRECISION AS baseline_phq9, p.gender_source_value AS gender, p.race_source_value AS race
                    FROM nrx_temp.ce_step4 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    UNION ALL
                    SELECT 'Step 4', 'Excluded', s.person_id, s.treatment, s.age_at_index, NULL::DOUBLE PRECISION, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step3 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step4)
                    UNION ALL
                    SELECT 'Step 5', 'Retained', s.person_id, s.treatment, s.age_at_index, NULL::DOUBLE PRECISION, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step5 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    UNION ALL
                    SELECT 'Step 5', 'Excluded', s.person_id, s.treatment, s.age_at_index, NULL::DOUBLE PRECISION, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step4 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step5)
                    UNION ALL
                    SELECT 'Step 6', 'Retained', s.person_id, s.treatment, s.age_at_index, s.baseline_phq9, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step6 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    UNION ALL
                    SELECT 'Step 6', 'Excluded', s.person_id, s.treatment, s.age_at_index, NULL::DOUBLE PRECISION, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step5 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step6)
                    UNION ALL
                    SELECT 'Step 7', 'Retained', s.person_id, s.treatment, s.age_at_index, s.baseline_phq9, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step7 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    UNION ALL
                    SELECT 'Step 7', 'Excluded', s.person_id, s.treatment, s.age_at_index, s.baseline_phq9, p.gender_source_value, p.race_source_value
                    FROM nrx_temp.ce_step6 s JOIN analytics_omop.person p ON p.person_id = s.person_id
                    WHERE s.person_id NOT IN (SELECT person_id FROM nrx_temp.ce_step7)
                )
                SELECT
                    step_name,
                    status,
                    treatment,
                    COUNT(*) AS n,
                    AVG(age_at_index) AS mean_age,
                    STDDEV(age_at_index) AS sd_age,
                    AVG(baseline_phq9) AS mean_baseline_phq9,
                    COUNT(*) FILTER (WHERE gender = 'F') AS n_female,
                    COUNT(*) FILTER (WHERE gender = 'M') AS n_male,
                    COUNT(*) FILTER (WHERE race ILIKE '%%White%%') AS n_white,
                    COUNT(*) FILTER (WHERE race ILIKE '%%Black%%' OR race ILIKE '%%African%%') AS n_black,
                    COUNT(*) FILTER (WHERE race ILIKE '%%Asian%%') AS n_asian
                FROM unioned
                GROUP BY step_name, status, treatment
                ORDER BY step_name, status, treatment
            """)
            # 5b: Dual-exposed patients
            dual_rows = self.db.select("""
                WITH firsts AS (
                    SELECT person_id,
                           _procedure_concept_name AS treatment,
                           MIN(procedure_date) AS first_date
                    FROM analytics_omop.procedure_occurrence
                    WHERE _procedure_concept_name IN ('Ketamine', 'Esketamine')
                      AND _route_concept_name IN ('Intravenous', 'Nasal')
                      AND NOT (
                          (_source_created_at::DATE - procedure_date) > 10
                          AND (_source_updated_at::DATE - procedure_date) > -1
                      )
                    GROUP BY person_id, _procedure_concept_name
                ),
                duals AS (
                    SELECT
                        f1.person_id,
                        CASE WHEN f1.first_date < f2.first_date THEN f1.treatment ELSE f2.treatment END AS first_treatment,
                        ABS((f1.first_date - f2.first_date)::INT) AS days_between
                    FROM firsts f1
                    JOIN firsts f2 ON f1.person_id = f2.person_id AND f1.treatment <> f2.treatment
                    WHERE f1.person_id IN (
                        SELECT person_id FROM nrx_temp.ce_step1
                        EXCEPT
                        SELECT person_id FROM nrx_temp.ce_step2
                    )
                )
                SELECT
                    first_treatment,
                    COUNT(DISTINCT person_id) AS n_patients,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_between) AS median_days_between,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY days_between) AS q1_days_between,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY days_between) AS q3_days_between
                FROM duals
                GROUP BY first_treatment
            """)
        return pd.DataFrame(attrition_rows), pd.DataFrame(dual_rows)

    def run_power_analysis_inputs(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """Section 8 power-analysis input tables based on ce_step7."""
        with self.db.transaction():
            variance_rows = self.db.select("""
                WITH post AS (
                    SELECT s.person_id,
                           s.treatment,
                           m.value_as_number AS post_score
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                ),
                within_sd AS (
                    SELECT treatment, person_id, STDDEV(post_score) AS sd_within
                    FROM post
                    GROUP BY treatment, person_id
                )
                SELECT
                    s.treatment,
                    STDDEV(s.baseline_phq9) AS baseline_sd,
                    AVG(w.sd_within) AS mean_within_patient_sd,
                    POWER(STDDEV(s.baseline_phq9), 2) AS between_var,
                    POWER(AVG(w.sd_within), 2) AS within_var
                FROM nrx_temp.ce_step7 s
                LEFT JOIN within_sd w
                  ON w.person_id = s.person_id
                 AND w.treatment = s.treatment
                GROUP BY s.treatment
            """)
            freq_rows = self.db.select("""
                WITH post AS (
                    SELECT s.person_id, s.treatment, m.measurement_date, s.index_date
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                ),
                counts AS (
                    SELECT treatment, person_id, COUNT(*) AS n_post
                    FROM post
                    GROUP BY treatment, person_id
                ),
                intervals AS (
                    SELECT
                        treatment,
                        person_id,
                        (measurement_date - LAG(measurement_date) OVER (
                            PARTITION BY treatment, person_id ORDER BY measurement_date
                        ))::INT AS days_between
                    FROM post
                )
                SELECT
                    c.treatment,
                    AVG(c.n_post) AS mean_n_post,
                    STDDEV(c.n_post) AS sd_n_post,
                    AVG(i.days_between) AS mean_days_between_post,
                    STDDEV(i.days_between) AS sd_days_between_post
                FROM counts c
                LEFT JOIN intervals i
                  ON i.person_id = c.person_id
                 AND i.treatment = c.treatment
                GROUP BY c.treatment
            """)
            traj_rows = self.db.select("""
                WITH post AS (
                    SELECT
                        s.person_id,
                        s.treatment,
                        s.baseline_phq9,
                        (m.measurement_date - s.index_date)::INT AS day_from_index,
                        m.value_as_number AS phq9
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.measurement m
                      ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                )
                SELECT
                    treatment,
                    CASE
                        WHEN day_from_index BETWEEN 1 AND 14 THEN 'Days 1-14'
                        WHEN day_from_index BETWEEN 15 AND 28 THEN 'Days 15-28'
                        ELSE 'Days 29-42'
                    END AS time_window,
                    AVG(phq9) AS mean_phq9,
                    STDDEV(phq9) AS sd_phq9,
                    AVG(phq9 - baseline_phq9) AS mean_change_from_baseline,
                    STDDEV(phq9 - baseline_phq9) AS sd_change_from_baseline
                FROM post
                GROUP BY treatment, time_window
                ORDER BY treatment, time_window
            """)
            # Individual-level PHQ-9 data for R power analysis (LME + IPTW)
            phq9_individual_rows = self.db.select("""
                SELECT
                    s.person_id,
                    s.treatment,
                    s.baseline_phq9,
                    m.value_as_number AS phq9,
                    (m.measurement_date - s.index_date)::INT AS days_from_index
                FROM nrx_temp.ce_step7 s
                JOIN analytics_omop.measurement m
                  ON m.person_id = s.person_id
                WHERE m.measurement_source_value = 'PHQ-9'
                  AND m.measurement_date > s.index_date
                  AND m.measurement_date <= s.index_date + 42
                ORDER BY s.person_id, m.measurement_date
            """)
        variance_df = pd.DataFrame(variance_rows)
        if not variance_df.empty:
            variance_df["icc"] = variance_df["between_var"] / (variance_df["between_var"] + variance_df["within_var"])
        phq9_individual_df = pd.DataFrame(phq9_individual_rows)
        phq9_individual_df.to_csv(TABDIR / "power_phq9_individual.csv", index=False)
        return variance_df, pd.DataFrame(freq_rows), pd.DataFrame(traj_rows)

    def run_bipolar_exploratory(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        """Section 9 exploratory bipolar cohort outputs."""
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.bp_step0")
            self.db.execute("""
                CREATE TABLE nrx_temp.bp_step0 AS
                SELECT b.*
                FROM nrx_temp.ce_bipolar_routed b
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM analytics_omop.condition_occurrence co
                    WHERE co.person_id = b.person_id
                      AND (
                        co._condition_concept_code LIKE 'F20%%'
                        OR co._condition_concept_code LIKE 'F25%%'
                        OR co._condition_concept_code LIKE 'F28%%'
                        OR co._condition_concept_code LIKE 'F29%%'
                      )
                )
            """)
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.bp_step1")
            self.db.execute("CREATE TABLE nrx_temp.bp_step1 AS SELECT * FROM nrx_temp.bp_step0 WHERE age_at_index >= 18")
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.bp_step2")
            self.db.execute("""
                CREATE TABLE nrx_temp.bp_step2 AS
                WITH baseline_phq9 AS (
                    SELECT s.person_id,
                           m.value_as_number AS baseline_phq9,
                           m.measurement_date AS baseline_phq9_date,
                           ROW_NUMBER() OVER (PARTITION BY s.person_id ORDER BY m.measurement_date DESC) AS rn
                    FROM nrx_temp.bp_step1 s
                    JOIN analytics_omop.measurement m ON m.person_id = s.person_id
                    WHERE m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date >= s.index_date - 30
                      AND m.measurement_date < s.index_date
                )
                SELECT s.*, b.baseline_phq9, b.baseline_phq9_date
                FROM nrx_temp.bp_step1 s
                JOIN baseline_phq9 b ON b.person_id = s.person_id AND b.rn = 1
            """)
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.bp_step3")
            self.db.execute("""
                CREATE TABLE nrx_temp.bp_step3 AS
                SELECT s.*
                FROM nrx_temp.bp_step2 s
                WHERE EXISTS (
                    SELECT 1 FROM analytics_omop.measurement m
                    WHERE m.person_id = s.person_id
                      AND m.measurement_source_value = 'PHQ-9'
                      AND m.measurement_date > s.index_date
                      AND m.measurement_date <= s.index_date + 42
                )
            """)
            enum_rows = self.db.select("""
                SELECT 0 AS step, 'Bipolar routed and psychosis excluded' AS description, treatment, COUNT(*) AS n FROM nrx_temp.bp_step0 GROUP BY treatment
                UNION ALL
                SELECT 1, 'Age >=18', treatment, COUNT(*) FROM nrx_temp.bp_step1 GROUP BY treatment
                UNION ALL
                SELECT 2, 'Baseline PHQ-9', treatment, COUNT(*) FROM nrx_temp.bp_step2 GROUP BY treatment
                UNION ALL
                SELECT 3, 'Post-baseline PHQ-9', treatment, COUNT(*) FROM nrx_temp.bp_step3 GROUP BY treatment
                ORDER BY step, treatment
            """)
            baseline_rows = self.db.select("""
                SELECT
                    b.treatment,
                    COUNT(*) AS n,
                    AVG(b.age_at_index) AS mean_age,
                    STDDEV(b.age_at_index) AS sd_age,
                    AVG(b.baseline_phq9) AS mean_baseline_phq9,
                    STDDEV(b.baseline_phq9) AS sd_baseline_phq9,
                    COUNT(*) FILTER (WHERE p.gender_source_value = 'F') AS n_female,
                    COUNT(*) FILTER (WHERE p.gender_source_value = 'M') AS n_male,
                    COUNT(*) FILTER (WHERE p.race_source_value ILIKE '%%White%%') AS n_white,
                    COUNT(*) FILTER (WHERE p.race_source_value ILIKE '%%Black%%' OR p.race_source_value ILIKE '%%African%%') AS n_black,
                    COUNT(*) FILTER (WHERE p.race_source_value ILIKE '%%Asian%%') AS n_asian,
                    COUNT(*) FILTER (WHERE p.ethnicity_source_value ILIKE '%%Hispanic%%' AND p.ethnicity_source_value NOT ILIKE '%%Non%%') AS n_hispanic,
                    AVG(z.median_income) AS mean_median_income,
                    STDDEV(z.median_income) AS sd_median_income,
                    COUNT(*) FILTER (WHERE z.median_income IS NOT NULL) AS n_income_available
                FROM nrx_temp.bp_step3 b
                JOIN analytics_omop.person p ON p.person_id = b.person_id
                LEFT JOIN analytics_omop.location loc ON loc.location_id = p.location_id
                LEFT JOIN nrx_temp.zip_income_acs5 z
                  ON LEFT(
                        regexp_replace(COALESCE(loc.zip::text, ''), '[^0-9]', '', 'g'),
                        5
                     ) = z.zip_code
                GROUP BY b.treatment
                ORDER BY b.treatment
            """)
        enum_df = pd.DataFrame(enum_rows)
        baseline_df = pd.DataFrame(baseline_rows)
        if not baseline_df.empty:
            baseline_df["flag_arm_lt30"] = baseline_df["n"] < 30
        return enum_df, baseline_df

    def run_dosing_descriptives(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
        """Section 6 dosing descriptives for ce_step7.

        Returns (availability_df, session_counts_df, dose_distribution_df, session_frequency_df, details).
        """
        details: dict = {"ambiguities": []}
        with self.db.transaction():
            dose_cols = self.db.select("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'analytics_omop'
                  AND table_name = 'procedure_occurrence'
                  AND (
                    column_name ILIKE '%dose%'
                    OR column_name ILIKE '%quantity%'
                    OR column_name ILIKE '%amount%'
                  )
                ORDER BY column_name
            """)
        if not dose_cols:
            details["ambiguities"].append(
                "No obvious dose/quantity column found in analytics_omop.procedure_occurrence."
            )
            return pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), details

        dose_col = dose_cols[0]["column_name"]
        details["dose_column_used"] = dose_col
        with self.db.transaction():
            self.db.execute("DROP TABLE IF EXISTS nrx_temp.acute_sessions")
            self.db.execute(f"""
                CREATE TABLE nrx_temp.acute_sessions AS
                WITH tx AS (
                    SELECT
                        s.person_id,
                        s.treatment,
                        s.index_date,
                        po.procedure_date,
                        po.{dose_col}::DOUBLE PRECISION AS dose_mg,
                        ROW_NUMBER() OVER (
                            PARTITION BY s.person_id, s.treatment
                            ORDER BY po.procedure_date
                        ) AS session_num
                    FROM nrx_temp.ce_step7 s
                    JOIN analytics_omop.procedure_occurrence po
                      ON po.person_id = s.person_id
                    WHERE po._procedure_concept_name = s.treatment
                      AND po.procedure_date >= s.index_date
                      AND po.procedure_date <= s.index_date + 42
                      AND NOT (
                          (po._source_created_at::DATE - po.procedure_date) > 10
                          AND (po._source_updated_at::DATE - po.procedure_date) > -1
                      )
                )
                SELECT *
                FROM tx
                WHERE session_num <= 8
            """)
            availability_rows = self.db.select(f"""
                SELECT
                    treatment,
                    COUNT(*) AS n_sessions,
                    COUNT(*) FILTER (WHERE dose_mg IS NOT NULL) AS n_sessions_with_dose,
                    ROUND(
                        100.0 * COUNT(*) FILTER (WHERE dose_mg IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0),
                        1
                    ) AS pct_sessions_with_dose
                FROM nrx_temp.acute_sessions
                GROUP BY treatment
                ORDER BY treatment
            """)
            sessions_rows = self.db.select("""
                WITH per_patient AS (
                    SELECT treatment, person_id, COUNT(*) AS n_sessions
                    FROM nrx_temp.acute_sessions
                    GROUP BY treatment, person_id
                )
                SELECT
                    treatment,
                    AVG(n_sessions) AS mean_sessions,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY n_sessions) AS median_sessions,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY n_sessions) AS q1_sessions,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY n_sessions) AS q3_sessions,
                    MIN(n_sessions) AS min_sessions,
                    MAX(n_sessions) AS max_sessions,
                    SUM(CASE WHEN n_sessions >= 4 THEN 1 ELSE 0 END) AS n_patients_ge4
                FROM per_patient
                GROUP BY treatment
                ORDER BY treatment
            """)
            dose_rows = self.db.select("""
                SELECT
                    treatment,
                    COUNT(*) FILTER (WHERE dose_mg = 56) AS n_dose_56,
                    COUNT(*) FILTER (WHERE dose_mg = 84) AS n_dose_84,
                    COUNT(*) FILTER (WHERE dose_mg NOT IN (56, 84) AND dose_mg IS NOT NULL) AS n_dose_other,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dose_mg) AS median_dose_mg,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY dose_mg) AS q1_dose_mg,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY dose_mg) AS q3_dose_mg,
                    MIN(dose_mg) AS min_dose_mg,
                    MAX(dose_mg) AS max_dose_mg
                FROM nrx_temp.acute_sessions
                GROUP BY treatment
                ORDER BY treatment
            """)
            # 6d: Treatment session frequency by 2-week interval
            freq_rows = self.db.select("""
                WITH intervals AS (
                    SELECT
                        person_id,
                        treatment,
                        procedure_date,
                        index_date,
                        (procedure_date - index_date)::INT AS day_from_index,
                        (procedure_date - LAG(procedure_date) OVER (
                            PARTITION BY person_id, treatment ORDER BY procedure_date
                        ))::INT AS days_since_prev
                    FROM nrx_temp.acute_sessions
                ),
                with_period AS (
                    SELECT *,
                        CASE
                            WHEN day_from_index BETWEEN 0 AND 14 THEN 'Weeks 1-2'
                            WHEN day_from_index BETWEEN 15 AND 28 THEN 'Weeks 3-4'
                            WHEN day_from_index BETWEEN 29 AND 42 THEN 'Weeks 5-6'
                        END AS period
                    FROM intervals
                    WHERE days_since_prev IS NOT NULL
                ),
                categorized AS (
                    SELECT *,
                        CASE
                            WHEN days_since_prev BETWEEN 1 AND 4 THEN 'Twice weekly'
                            WHEN days_since_prev BETWEEN 5 AND 9 THEN 'Weekly'
                            WHEN days_since_prev BETWEEN 10 AND 16 THEN 'Every two weeks'
                            ELSE 'Other/irregular'
                        END AS freq_category
                    FROM with_period
                    WHERE period IS NOT NULL
                )
                SELECT
                    treatment,
                    period,
                    freq_category,
                    COUNT(*) AS n_intervals,
                    ROUND(100.0 * COUNT(*)::NUMERIC / SUM(COUNT(*)) OVER (PARTITION BY treatment, period), 1) AS pct_of_period,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_since_prev) AS median_days_between,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY days_since_prev) AS q1_days_between,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY days_since_prev) AS q3_days_between
                FROM categorized
                GROUP BY treatment, period, freq_category
                ORDER BY treatment, period, freq_category
            """)
        details["weight_adjusted_mg_per_kg"] = "Skipped intentionally (optional per protocol: where weight available)."
        return (
            pd.DataFrame(availability_rows),
            pd.DataFrame(sessions_rows),
            pd.DataFrame(dose_rows),
            pd.DataFrame(freq_rows),
            details,
        )

