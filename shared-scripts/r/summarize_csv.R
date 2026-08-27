#!/usr/bin/env Rscript
# Kuhn shared script: summarize-csv (issue #68).
#
# Deterministic exploratory summary of one CSV. Contract (all Kuhn shared
# scripts follow it):
#   - inputs are paths relative to the project root, mounted read-only at /work
#   - every output is written under $OUT_DIR (never into the project mount)
#   - exit non-zero with a message on stderr when the input is unusable
#
# Usage: Rscript summarize_csv.R --input <path/to/file.csv>

args <- commandArgs(trailingOnly = TRUE)

get_arg <- function(flag) {
  hit <- which(args == flag)
  if (length(hit) == 0 || hit[1] == length(args)) return(NULL)
  args[[hit[1] + 1]]
}

input <- get_arg("--input")
out_dir <- Sys.getenv("OUT_DIR", unset = "")
if (is.null(input) || !nzchar(out_dir)) {
  stop("usage: summarize_csv.R --input <file.csv> (requires OUT_DIR)", call. = FALSE)
}
if (!file.exists(input)) stop(sprintf("input not found: %s", input), call. = FALSE)

df <- utils::read.csv(input, check.names = FALSE, stringsAsFactors = FALSE)
if (ncol(df) == 0) stop("input has no columns", call. = FALSE)

num_or_na <- function(x) if (is.numeric(x)) x else rep(NA_real_, length(x))

summary_rows <- lapply(names(df), function(name) {
  col <- df[[name]]
  numeric <- is.numeric(col)
  data.frame(
    column = name,
    type = class(col)[1],
    n = length(col),
    missing = sum(is.na(col) | (is.character(col) & !nzchar(trimws(col)))),
    unique = length(unique(col[!is.na(col)])),
    mean = if (numeric) mean(col, na.rm = TRUE) else NA_real_,
    sd = if (numeric) stats::sd(col, na.rm = TRUE) else NA_real_,
    min = suppressWarnings(min(num_or_na(col), na.rm = TRUE)),
    median = if (numeric) stats::median(col, na.rm = TRUE) else NA_real_,
    max = suppressWarnings(max(num_or_na(col), na.rm = TRUE)),
    stringsAsFactors = FALSE
  )
})
summary_df <- do.call(rbind, summary_rows)
# min/max over an all-NA column yield +/-Inf with a warning; report NA instead.
for (col in c("min", "max")) summary_df[[col]][!is.finite(summary_df[[col]])] <- NA_real_

utils::write.csv(summary_df, file.path(out_dir, "summary.csv"), row.names = FALSE)

fmt <- function(x) ifelse(is.na(x), "—", format(round(x, 4), trim = TRUE, scientific = FALSE))
lines <- c(
  sprintf("# Summary of `%s`", basename(input)),
  "",
  sprintf("%d rows × %d columns.", nrow(df), ncol(df)),
  "",
  "| column | type | n | missing | unique | mean | sd | min | median | max |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  vapply(seq_len(nrow(summary_df)), function(i) {
    r <- summary_df[i, ]
    sprintf(
      "| %s | %s | %d | %d | %d | %s | %s | %s | %s | %s |",
      r$column, r$type, r$n, r$missing, r$unique,
      fmt(r$mean), fmt(r$sd), fmt(r$min), fmt(r$median), fmt(r$max)
    )
  }, character(1))
)
writeLines(lines, file.path(out_dir, "summary.md"))

cat(sprintf("Summarized %d columns of %s -> summary.csv, summary.md\n", ncol(df), input))
