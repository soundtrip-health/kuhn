"""Investigate Step 6 (TRD criterion) high dropout rate.

80% of patients are dropped at Step 6, which requires ≥2 distinct prior
antidepressants before the index date. This script digs into why.
"""

# %% Imports and setup
import os
import pandas as pd
from dotenv import load_dotenv
from postgres_client import PostgresClient
from utils import ANTIDEPRESSANTS

load_dotenv()
db = PostgresClient()

print(f"ANTIDEPRESSANTS list ({len(ANTIDEPRESSANTS)} drugs):")
for ad in sorted(set(ANTIDEPRESSANTS)):
    print(f"  {ad}")

# %% Step 5 and Step 6 counts — confirm the 80% drop
df_counts = pd.DataFrame(db.select("""
    SELECT 'step5' AS step, COUNT(*) AS n FROM nrx_temp.ce_step5
    UNION ALL
    SELECT 'step6' AS step, COUNT(*) AS n FROM nrx_temp.ce_step6
"""))
print(df_counts)
print(f"Drop rate: {1 - df_counts.set_index('step').loc['step6','n'] / df_counts.set_index('step').loc['step5','n']:.1%}")

# %% TRD ascertainment breakdown: how many patients have 0, 1, 2, 3+ prior ADs?
ad_clauses = " OR ".join(
    [f"de._drug_generic_concept_name ILIKE '%%{ad.lower()}%%'" for ad in ANTIDEPRESSANTS]
)

df_prior_ads = pd.DataFrame(db.select(f"""
    WITH prior_ads AS (
        SELECT s.person_id,
               COUNT(DISTINCT LOWER(BTRIM(de._drug_generic_concept_name))) AS n_distinct_ads
        FROM nrx_temp.ce_step5 s
        LEFT JOIN analytics_omop.drug_exposure de
          ON de.person_id = s.person_id
         AND de.drug_exposure_start_date < s.index_date
         AND ({ad_clauses})
        GROUP BY s.person_id
    )
    SELECT
        CASE
            WHEN n_distinct_ads >= 3 THEN '3+'
            ELSE n_distinct_ads::text
        END AS n_prior_ads,
        COUNT(*) AS n_patients
    FROM prior_ads
    GROUP BY 1
    ORDER BY 1
"""))
print("\nPrior AD count distribution (step5 patients):")
print(df_prior_ads)

# %% What drug names actually appear in drug_exposure for step5 patients?
# This checks if our ILIKE patterns are matching anything at all.
df_all_drugs = pd.DataFrame(db.select("""
    SELECT LOWER(BTRIM(de._drug_generic_concept_name)) AS drug_name,
           COUNT(DISTINCT de.person_id) AS n_patients,
           COUNT(*) AS n_records
    FROM nrx_temp.ce_step5 s
    JOIN analytics_omop.drug_exposure de
      ON de.person_id = s.person_id
     AND de.drug_exposure_start_date < s.index_date
    GROUP BY 1
    ORDER BY n_patients DESC
    LIMIT 50
"""))
print("\nTop 50 drug names (pre-index) for step5 patients:")
print(df_all_drugs.to_string())

# %% Which of those top drugs are antidepressants that our list DOES match?
df_matched = pd.DataFrame(db.select(f"""
    SELECT LOWER(BTRIM(de._drug_generic_concept_name)) AS drug_name,
           COUNT(DISTINCT de.person_id) AS n_patients,
           COUNT(*) AS n_records
    FROM nrx_temp.ce_step5 s
    JOIN analytics_omop.drug_exposure de
      ON de.person_id = s.person_id
     AND de.drug_exposure_start_date < s.index_date
    WHERE ({ad_clauses})
    GROUP BY 1
    ORDER BY n_patients DESC
"""))
print("\nMatched antidepressant drug names and patient counts:")
print(df_matched.to_string())

# %% Are there common antidepressants in the data that our list MISSES?
# Check for well-known ADs not in our list: TCAs, MAOIs, mirtazapine, etc.
missing_candidates = [
    "mirtazapine", "amitriptyline", "nortriptyline", "imipramine",
    "desipramine", "clomipramine", "doxepin", "trimipramine",
    "protriptyline", "maprotiline", "phenelzine", "tranylcypromine",
    "isocarboxazid", "selegiline", "moclobemide", "levomilnacipran",
    "brexpiprazole",  # augmentation agent, not AD per se
]

missing_clauses = " OR ".join(
    [f"LOWER(BTRIM(de._drug_generic_concept_name)) ILIKE '%%{d}%%'" for d in missing_candidates]
)

df_missing = pd.DataFrame(db.select(f"""
    SELECT LOWER(BTRIM(de._drug_generic_concept_name)) AS drug_name,
           COUNT(DISTINCT de.person_id) AS n_patients
    FROM nrx_temp.ce_step5 s
    JOIN analytics_omop.drug_exposure de
      ON de.person_id = s.person_id
     AND de.drug_exposure_start_date < s.index_date
    WHERE ({missing_clauses})
    GROUP BY 1
    ORDER BY n_patients DESC
"""))
print("\nPotentially missing antidepressants found in data:")
print(df_missing.to_string() if len(df_missing) > 0 else "  (none found)")

# %% How many step5 patients have ANY drug_exposure record before index date?
# This tells us if the issue is missing drug data entirely vs. missing AD matches.
df_any_drug = pd.DataFrame(db.select("""
    SELECT
        COUNT(DISTINCT s.person_id) AS n_step5,
        COUNT(DISTINCT CASE WHEN de.person_id IS NOT NULL THEN s.person_id END) AS n_with_any_drug,
        COUNT(DISTINCT CASE WHEN de.person_id IS NULL THEN s.person_id END) AS n_no_drug_records
    FROM nrx_temp.ce_step5 s
    LEFT JOIN analytics_omop.drug_exposure de
      ON de.person_id = s.person_id
     AND de.drug_exposure_start_date < s.index_date
"""))
print("\nStep5 patients with ANY pre-index drug_exposure records:")
print(df_any_drug.to_string())

# %% Check if the issue is the ILIKE matching being too narrow
# Compare exact match count vs ILIKE match count for a few common ADs
sample_ads = ["sertraline", "fluoxetine", "escitalopram", "bupropion", "venlafaxine", "duloxetine", "trazodone"]
for ad in sample_ads:
    row = db.select(f"""
        SELECT
            COUNT(DISTINCT CASE WHEN LOWER(BTRIM(de._drug_generic_concept_name)) = '{ad}' THEN s.person_id END) AS n_exact,
            COUNT(DISTINCT CASE WHEN de._drug_generic_concept_name ILIKE '%%{ad}%%' THEN s.person_id END) AS n_ilike
        FROM nrx_temp.ce_step5 s
        JOIN analytics_omop.drug_exposure de
          ON de.person_id = s.person_id
         AND de.drug_exposure_start_date < s.index_date
    """)[0]
    print(f"  {ad:20s}  exact={row['n_exact']:5d}  ilike={row['n_ilike']:5d}")

# %% What would the drop rate be if we required only ≥1 prior AD instead of ≥2?
df_threshold = pd.DataFrame(db.select(f"""
    WITH prior_ads AS (
        SELECT s.person_id,
               COUNT(DISTINCT LOWER(BTRIM(de._drug_generic_concept_name))) AS n_distinct_ads
        FROM nrx_temp.ce_step5 s
        LEFT JOIN analytics_omop.drug_exposure de
          ON de.person_id = s.person_id
         AND de.drug_exposure_start_date < s.index_date
         AND ({ad_clauses})
        GROUP BY s.person_id
    )
    SELECT
        COUNT(*) AS n_total,
        SUM(CASE WHEN n_distinct_ads >= 1 THEN 1 ELSE 0 END) AS n_ge1,
        SUM(CASE WHEN n_distinct_ads >= 2 THEN 1 ELSE 0 END) AS n_ge2,
        SUM(CASE WHEN n_distinct_ads >= 3 THEN 1 ELSE 0 END) AS n_ge3
    FROM prior_ads
"""))
print("\nRetention at different AD thresholds:")
print(df_threshold.to_string())

# %% By arm: is the drop concentrated in one treatment arm?
df_by_arm = pd.DataFrame(db.select(f"""
    WITH prior_ads AS (
        SELECT s.person_id, s.treatment,
               COUNT(DISTINCT LOWER(BTRIM(de._drug_generic_concept_name))) AS n_distinct_ads
        FROM nrx_temp.ce_step5 s
        LEFT JOIN analytics_omop.drug_exposure de
          ON de.person_id = s.person_id
         AND de.drug_exposure_start_date < s.index_date
         AND ({ad_clauses})
        GROUP BY s.person_id, s.treatment
    )
    SELECT treatment,
           COUNT(*) AS n_total,
           SUM(CASE WHEN n_distinct_ads = 0 OR n_distinct_ads IS NULL THEN 1 ELSE 0 END) AS n_zero,
           SUM(CASE WHEN n_distinct_ads = 1 THEN 1 ELSE 0 END) AS n_one,
           SUM(CASE WHEN n_distinct_ads >= 2 THEN 1 ELSE 0 END) AS n_trd_met
    FROM prior_ads
    GROUP BY treatment
    ORDER BY treatment
"""))
print("\nTRD criterion by treatment arm:")
print(df_by_arm.to_string())

# %% Summary
print("\n" + "="*60)
print("INVESTIGATION SUMMARY")
print("="*60)
print("Check the outputs above to determine if the 80% drop is due to:")
print("  1. Missing drug data (patients with no drug_exposure records)")
print("  2. Narrow AD list (common ADs like mirtazapine, TCAs not included)")
print("  3. ILIKE matching issues (drug names stored differently)")
print("  4. Legitimate low AD documentation in this EHR population")
