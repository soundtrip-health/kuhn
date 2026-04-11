# %% **************** SETUP ****************
from queries import ASCPQueries
from dotenv import load_dotenv
from pathlib import Path
from utils import TABDIR

load_dotenv(override=False)
env_candidates = [
    Path(__file__).parent / ".env",
    Path(__file__).parent.parent / ".env",
]
for env_path in env_candidates:
    if env_path.exists():
        load_dotenv(env_path, override=False)

# %% **************** COHORT ENUMERATION ****************
q = ASCPQueries()
summary_df, details = q.run_cohort_enumeration()
print(summary_df.to_string())
print(details)
ce_md_path = TABDIR / "cohort_enumeration.md"
with ce_md_path.open("w", encoding="utf-8") as f:
    f.write("# Cohort Enumeration\n\n")
    f.write(summary_df.to_markdown(index=False))
    f.write("\n")


# %% **************** PROPENSITY SCORE FEASIBILITY ****************
# Propensity Score Feasibility (requires ce_step7 + zip_income_acs5)
q.create_zip_income_table()
completeness_df, distributions_df, extended_df, meds_df = q.run_propensity_score_feasibility()
print(completeness_df.to_string())
print(distributions_df.to_string())
print(extended_df.to_string())
print(meds_df.to_string())

ps_md_path = TABDIR / "propensity_score_feasibility.md"
with ps_md_path.open("w", encoding="utf-8") as f:
    f.write("# Propensity Score Feasibility\n\n")
    f.write("## Completeness\n")
    f.write(completeness_df.to_markdown(index=False))
    f.write("\n\n## Distributions\n")
    f.write(distributions_df.to_markdown(index=False))
    f.write("\n\n## Extended Metrics\n")
    f.write(extended_df.to_markdown(index=False))
    f.write("\n\n## Concomitant Medication Classes\n")
    f.write(meds_df.to_markdown(index=False))
    f.write("\n")

print(f"Saved markdown report: {ps_md_path}")

# %% **************** ASSESSMENT DENSITY ****************
phq9_count_df, phq9_timing_df, alt_inst_df = q.run_assessment_density()
phq9_count_df.to_csv(TABDIR / "assessment_density_post_phq9_counts.csv", index=False)
phq9_timing_df.to_csv(TABDIR / "assessment_density_timing.csv", index=False)
alt_inst_df.to_csv(TABDIR / "assessment_density_alternative_instruments.csv", index=False)

# %% **************** SUBGROUP CELL SIZES ****************
subgroup_df = q.run_subgroup_cell_sizes()

# %% **************** SUPPLEMENTARY TABLES ****************
attrition_df, dual_exposure_df = q.run_supplementary_tables()
attrition_df.to_csv(TABDIR / "supplement_attrition_comparison.csv", index=False)
dual_exposure_df.to_csv(TABDIR / "supplement_dual_exposed_details.csv", index=False)

# %% **************** DOSING DESCRIPTIVES ****************
dose_availability_df, dose_sessions_df, dose_distribution_df, session_freq_df, dosing_details = q.run_dosing_descriptives()
dose_availability_df.to_csv(TABDIR / "dosing_availability.csv", index=False)
dose_sessions_df.to_csv(TABDIR / "dosing_session_counts.csv", index=False)
dose_distribution_df.to_csv(TABDIR / "dosing_distributions.csv", index=False)
session_freq_df.to_csv(TABDIR / "dosing_session_frequency.csv", index=False)
print(dosing_details)

# %% **************** POWER INPUTS ****************
var_df, freq_df, traj_df = q.run_power_analysis_inputs()
var_df.to_csv(TABDIR / "power_variance_components.csv", index=False)
freq_df.to_csv(TABDIR / "power_assessment_frequency.csv", index=False)
traj_df.to_csv(TABDIR / "power_observed_trajectories.csv", index=False)

# %% **************** EXPLORATORY BIPOLAR ****************
bipolar_enum_df, bipolar_baseline_df = q.run_bipolar_exploratory()
bipolar_enum_df.to_csv(TABDIR / "bipolar_enumeration.csv", index=False)
bipolar_baseline_df.to_csv(TABDIR / "bipolar_baseline_characteristics.csv", index=False)

# %%
