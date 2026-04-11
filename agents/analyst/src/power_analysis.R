#!/usr/bin/env Rscript
# Power Analysis for NRX Feasibility Study (Spec Section 8)
#
# Loads CSV outputs from the Python pipeline and computes:
#   8d. Effective sample size after IPTW (propensity score model + stabilized weights)
#   8e. Power calculation for LME non-inferiority test (NI margin = 0.6 PHQ-9 points)
#
# Inputs (from draft/tables/):
#   - ps_covariates_individual.csv   (individual-level covariates for PS model)
#   - power_phq9_individual.csv      (individual-level post-baseline PHQ-9 for LME)
#   - power_variance_components.csv  (between/within variance estimates)
#   - power_assessment_frequency.csv (mean assessments per patient)
#
# Outputs (to draft/tables/):
#   - power_iptw_results.csv         (effective N, design effect, per arm)
#   - power_analysis_results.csv     (power, CI width, summary)

library(dplyr)
library(readr)

tabdir <- file.path("draft", "tables")

# ─── Load data ────────────────────────────────────────────────────────────────

cov <- read_csv(file.path(tabdir, "ps_covariates_individual.csv"), show_col_types = FALSE)
phq9 <- read_csv(file.path(tabdir, "power_phq9_individual.csv"), show_col_types = FALSE)
var_comp <- read_csv(file.path(tabdir, "power_variance_components.csv"), show_col_types = FALSE)
assess_freq <- read_csv(file.path(tabdir, "power_assessment_frequency.csv"), show_col_types = FALSE)

cat("Loaded covariates:", nrow(cov), "patients\n")
cat("Loaded PHQ-9 observations:", nrow(phq9), "rows\n")

# ─── 8d. Propensity Score Model + IPTW ───────────────────────────────────────

# Prepare covariates for logistic regression
cov <- cov %>%
  mutate(
    tx = as.integer(treatment == "Esketamine"),
    gender = factor(gender),
    race = factor(race),
    ethnicity = factor(ethnicity),
    trd_status = as.integer(trd_status),
    concurrent_oral_ad_at_baseline = as.integer(concurrent_oral_ad_at_baseline)
  )

# Impute missing median_income with median (avoid dropping patients)
if (any(is.na(cov$median_income))) {
  med_inc <- median(cov$median_income, na.rm = TRUE)
  cat("Imputing", sum(is.na(cov$median_income)), "missing median_income values with", med_inc, "\n")
  cov$median_income[is.na(cov$median_income)] <- med_inc
}

# Impute missing baseline_phq9_item9 with median
if (any(is.na(cov$baseline_phq9_item9))) {
  med_i9 <- median(cov$baseline_phq9_item9, na.rm = TRUE)
  cat("Imputing", sum(is.na(cov$baseline_phq9_item9)), "missing Item 9 values with", med_i9, "\n")
  cov$baseline_phq9_item9[is.na(cov$baseline_phq9_item9)] <- med_i9
}

# Fit propensity score model
ps_formula <- tx ~ baseline_phq9 + baseline_phq9_item9 + age_at_index +
  gender + race + ethnicity + median_income + trd_status +
  concurrent_oral_ad_at_baseline

# Drop rows with any remaining NA in model variables (shouldn't be many)
model_vars <- all.vars(ps_formula)
cov_complete <- cov %>% filter(complete.cases(across(all_of(model_vars))))
cat("Patients with complete covariates:", nrow(cov_complete), "/", nrow(cov), "\n")

ps_model <- glm(ps_formula, data = cov_complete, family = binomial(link = "logit"))
cat("\nPropensity score model summary:\n")
print(summary(ps_model))

cov_complete$ps <- predict(ps_model, type = "response")

# Stabilized ATE weights
p_tx <- mean(cov_complete$tx)
cov_complete <- cov_complete %>%
  mutate(
    raw_weight = ifelse(tx == 1, p_tx / ps, (1 - p_tx) / (1 - ps))
  )

# Truncate at 1st/99th percentiles
q01 <- quantile(cov_complete$raw_weight, 0.01)
q99 <- quantile(cov_complete$raw_weight, 0.99)
cat("\nWeight truncation bounds: [", round(q01, 3), ",", round(q99, 3), "]\n")
cov_complete <- cov_complete %>%
  mutate(weight = pmin(pmax(raw_weight, q01), q99))

# Effective sample size per arm: (sum(w))^2 / sum(w^2)
ess_by_arm <- cov_complete %>%
  group_by(treatment) %>%
  summarise(
    n_nominal = n(),
    sum_w = sum(weight),
    sum_w2 = sum(weight^2),
    effective_n = sum_w^2 / sum_w2,
    design_effect = n_nominal / (sum_w^2 / sum_w2),
    .groups = "drop"
  )

cat("\n── 8d. Effective Sample Size After IPTW ──\n")
print(as.data.frame(ess_by_arm))

write_csv(ess_by_arm, file.path(tabdir, "power_iptw_results.csv"))

# ─── 8e. Power Calculation ───────────────────────────────────────────────────

# NI margin from protocol Section 3.2
ni_margin <- 0.6  # PHQ-9 points

# Variance components (use pooled across arms)
sigma2_between <- mean(var_comp$between_var, na.rm = TRUE)
sigma2_within <- mean(var_comp$within_var, na.rm = TRUE)
sigma2_total <- sigma2_between + sigma2_within

# Mean number of post-baseline assessments per patient
mean_k <- mean(assess_freq$mean_n_post, na.rm = TRUE)

cat("\n── Variance Components (pooled) ──\n")
cat("Between-patient variance:", round(sigma2_between, 3), "\n")
cat("Within-patient variance: ", round(sigma2_within, 3), "\n")
cat("ICC:                     ", round(sigma2_between / sigma2_total, 3), "\n")
cat("Mean assessments/patient:", round(mean_k, 2), "\n")

# Effective N per arm (use minimum for conservative estimate)
n1_eff <- min(ess_by_arm$effective_n)
n2_eff <- max(ess_by_arm$effective_n)

cat("Effective N (smaller arm):", round(n1_eff, 1), "\n")
cat("Effective N (larger arm): ", round(n2_eff, 1), "\n")

# SE of the treatment x time interaction in an LME
# For a random-intercept model with repeated measures:
#   Var(beta_treatment_x_time) ≈ (sigma2_within / k + sigma2_between) * (1/n1 + 1/n2)
# where k = mean assessments per patient
#
# The treatment effect in an LME with time interaction is estimated from
# the difference in slopes. The variance of the slope difference is:
#   Var(delta_slope) ≈ 2 * sigma2_within / (k * sum_t2) * (1/n1 + 1/n2)
# where sum_t2 = sum of squared centered time points.
#
# For a simpler analytical approximation, we use the approach from
# Hedeker et al. (1999) for repeated-measures designs:
#   SE ≈ sqrt(sigma2_total * (1 + (k-1)*rho) / (k * n_eff_harmonic))
# where rho = ICC, n_eff_harmonic = harmonic mean of arm sizes

icc <- sigma2_between / sigma2_total
n_eff_harmonic <- 2 / (1/n1_eff + 1/n2_eff)

# Design effect for clustering within patients
deff_cluster <- 1 + (mean_k - 1) * icc

# SE of the treatment effect (mean difference at endpoint)
se_treatment <- sqrt(sigma2_total * deff_cluster / (mean_k * n_eff_harmonic))

cat("\nDesign effect (clustering):", round(deff_cluster, 3), "\n")
cat("SE of treatment effect:   ", round(se_treatment, 4), "\n")

# Non-inferiority test: reject H0 if upper bound of 95% CI < NI margin
# Under true equivalence (effect = 0):
#   Power = P(estimate + 1.96*SE < NI_margin)
#         = P(Z < (NI_margin / SE) - 1.96)
z_power <- (ni_margin / se_treatment) - qnorm(0.975)
power <- pnorm(z_power)

cat("\n── 8e. Power Calculation ──\n")
cat("NI margin:      ", ni_margin, "PHQ-9 points\n")
cat("z for power:    ", round(z_power, 3), "\n")
cat("Expected power: ", round(power * 100, 1), "%\n")

# CI width (if power > 90%)
ci_width <- 2 * qnorm(0.975) * se_treatment
cat("Expected 95% CI width:", round(ci_width, 3), "PHQ-9 points\n")

# Context: EQUIVALENCE trial benchmark
cat("\nBenchmark: EQUIVALENCE trial required 200/arm at 80% power",
    "(QIDS-based LME, NI margin 1.0)\n")
cat("This study NI margin: 0.6 PHQ-9 points (stricter)\n")

# ─── Save results ─────────────────────────────────────────────────────────────

results <- tibble(
  ni_margin = ni_margin,
  sigma2_between = sigma2_between,
  sigma2_within = sigma2_within,
  icc = icc,
  mean_assessments_per_patient = mean_k,
  effective_n_arm1 = n1_eff,
  effective_n_arm2 = n2_eff,
  effective_n_harmonic = n_eff_harmonic,
  design_effect_clustering = deff_cluster,
  se_treatment_effect = se_treatment,
  expected_power = power,
  expected_ci_width = ci_width,
  arm1 = ess_by_arm$treatment[which.min(ess_by_arm$effective_n)],
  arm2 = ess_by_arm$treatment[which.max(ess_by_arm$effective_n)]
)

write_csv(results, file.path(tabdir, "power_analysis_results.csv"))
cat("\nResults saved to", file.path(tabdir, "power_iptw_results.csv"),
    "and", file.path(tabdir, "power_analysis_results.csv"), "\n")
