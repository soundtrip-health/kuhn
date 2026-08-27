#!/usr/bin/env Rscript
# Kuhn shared script: gamm-smooth-trends (issue #68).
#
# Fit a generalized additive (mixed) model of an outcome over a continuous
# predictor (typically time), with an optional grouping factor as a random
# intercept, and write a reproducible summary + diagnostic outputs.
#
# Contract (all Kuhn shared scripts follow it):
#   - inputs are paths relative to the project root, mounted read-only at /work
#   - every output is written under $OUT_DIR (never into the project mount)
#   - exit non-zero with a message on stderr when the input is unusable
#
# Usage:
#   Rscript gamm_smooth_trends.R --input data.csv --outcome y --predictor x \
#     [--group subject_id] [--k 10] [--family gaussian]
#
# Outputs under $OUT_DIR:
#   model_summary.txt   full mgcv summary
#   smooth_terms.csv    tidy smooth-term table (edf, F/Chi.sq, p)
#   parametric_terms.csv tidy parametric coefficients
#   fitted_curve.csv    predictor grid with fit and 95% CI (per group = "population")
#   smooth_plot.png     fitted smooth with CI ribbon over the data

suppressPackageStartupMessages({
  library(mgcv)
})

args <- commandArgs(trailingOnly = TRUE)
get_arg <- function(flag, default = NULL) {
  hit <- which(args == flag)
  if (length(hit) == 0 || hit[1] == length(args)) return(default)
  args[[hit[1] + 1]]
}

input <- get_arg("--input")
outcome <- get_arg("--outcome")
predictor <- get_arg("--predictor")
group <- get_arg("--group")
k <- as.integer(get_arg("--k", "10"))
family_name <- get_arg("--family", "gaussian")
out_dir <- Sys.getenv("OUT_DIR", unset = "")

if (is.null(input) || is.null(outcome) || is.null(predictor) || !nzchar(out_dir)) {
  stop("usage: gamm_smooth_trends.R --input <csv> --outcome <col> --predictor <col> [--group <col>] [--k n] [--family f]",
       call. = FALSE)
}
if (!file.exists(input)) stop(sprintf("input not found: %s", input), call. = FALSE)

df <- utils::read.csv(input, check.names = FALSE, stringsAsFactors = FALSE)
for (col in c(outcome, predictor, group)) {
  if (!is.null(col) && !col %in% names(df)) {
    stop(sprintf("column not in %s: %s", input, col), call. = FALSE)
  }
}
df <- df[stats::complete.cases(df[, c(outcome, predictor, group)]), , drop = FALSE]
if (nrow(df) < 10) stop("fewer than 10 complete rows — not enough to fit a smooth", call. = FALSE)

fam <- switch(family_name,
  gaussian = stats::gaussian(),
  binomial = stats::binomial(),
  poisson = stats::poisson(),
  Gamma = stats::Gamma(link = "log"),
  stop(sprintf("unsupported family: %s (use gaussian, binomial, poisson, or Gamma)", family_name), call. = FALSE)
)

# bam() scales to long series; a grouping column becomes a random intercept
# via the "re" basis (the standard mgcv idiom for simple GAMMs).
has_group <- !is.null(group)
if (has_group) df[[group]] <- factor(df[[group]])
formula_text <- if (has_group) {
  sprintf("`%s` ~ s(`%s`, k = %d) + s(%s, bs = \"re\")", outcome, predictor, k, sprintf("`%s`", group))
} else {
  sprintf("`%s` ~ s(`%s`, k = %d)", outcome, predictor, k)
}
model <- mgcv::bam(stats::as.formula(formula_text), data = df, family = fam, method = "fREML")

# --- model_summary.txt ------------------------------------------------------
summary_lines <- utils::capture.output({
  cat("Formula:", formula_text, "\n")
  cat("Family:", family_name, "  n =", nrow(df), "\n\n")
  print(summary(model))
  cat("\nBasis dimension check (k.check):\n")
  print(mgcv::k.check(model))
})
writeLines(summary_lines, file.path(out_dir, "model_summary.txt"))

# --- tidy term tables -------------------------------------------------------
s <- summary(model)
smooth_df <- as.data.frame(s$s.table)
smooth_df <- cbind(term = rownames(smooth_df), smooth_df)
utils::write.csv(smooth_df, file.path(out_dir, "smooth_terms.csv"), row.names = FALSE)
param_df <- as.data.frame(s$p.table)
param_df <- cbind(term = rownames(param_df), param_df)
utils::write.csv(param_df, file.path(out_dir, "parametric_terms.csv"), row.names = FALSE)

# --- population-level fitted curve with 95% CI ------------------------------
grid <- data.frame(x = seq(min(df[[predictor]]), max(df[[predictor]]), length.out = 200))
names(grid) <- predictor
if (has_group) {
  grid[[group]] <- factor(levels(df[[group]])[1], levels = levels(df[[group]]))
}
# exclude the random-effect smooth so the curve is the population trend
exclude <- if (has_group) sprintf("s(%s)", group) else NULL
pred <- mgcv::predict.bam(model, newdata = grid, type = "link", se.fit = TRUE, exclude = exclude)
inv <- fam$linkinv
curve <- data.frame(
  predictor = grid[[predictor]],
  fit = inv(pred$fit),
  lower = inv(pred$fit - 1.96 * pred$se.fit),
  upper = inv(pred$fit + 1.96 * pred$se.fit)
)
names(curve)[1] <- predictor
utils::write.csv(curve, file.path(out_dir, "fitted_curve.csv"), row.names = FALSE)

# --- smooth_plot.png --------------------------------------------------------
grDevices::png(file.path(out_dir, "smooth_plot.png"), width = 1200, height = 800, res = 150)
plot(df[[predictor]], df[[outcome]], pch = 16, cex = 0.5,
     col = grDevices::adjustcolor("grey30", alpha.f = 0.35),
     xlab = predictor, ylab = outcome,
     main = sprintf("Smooth trend of %s over %s", outcome, predictor))
graphics::polygon(c(curve[[predictor]], rev(curve[[predictor]])),
                  c(curve$lower, rev(curve$upper)),
                  border = NA, col = grDevices::adjustcolor("steelblue", alpha.f = 0.25))
graphics::lines(curve[[predictor]], curve$fit, col = "steelblue", lwd = 2)
invisible(grDevices::dev.off())

cat(sprintf("Fitted %s; wrote model_summary.txt, smooth_terms.csv, parametric_terms.csv, fitted_curve.csv, smooth_plot.png\n",
            formula_text))
