#!/usr/bin/env Rscript
# Build the NSDUH-2023 analysis extract for the Kuhn E2E test project.
# Input:  build/**/*.rdata|*.RData (from fetch-nsduh.sh — the SAMHSA R bundle)
# Output: build/nsduh-2023-extract.csv  + build/extract-manifest.md
#
# Selection is by exact candidate names + substance-stem patterns, and the
# manifest reports exactly what was found/missing — variables.md documents the
# intent; the manifest is the ground truth.

suppressMessages(library(data.table))

build <- "build"
rdata <- list.files(build, pattern = "\\.[Rr][Dd]ata$", recursive = TRUE, full.names = TRUE)
if (length(rdata) == 0) stop("No .RData file under build/ — run ./fetch-nsduh.sh first")
if (length(rdata) > 1) message("Multiple .RData files; using: ", rdata[1])

env <- new.env()
objs <- load(rdata[1], envir = env)
message("Loaded object(s): ", paste(objs, collapse = ", "))
# The bundle can carry extras (e.g. .Random.seed) — take the data-frame object.
is_df <- vapply(objs, function(o) is.data.frame(get(o, envir = env)), logical(1))
if (!any(is_df)) stop("No data.frame object found in ", rdata[1])
df <- get(objs[which(is_df)[1]], envir = env)
message("Using object: ", objs[which(is_df)[1]])
setDT(df)
setnames(df, toupper(names(df)))   # PUF releases vary in case
message(sprintf("Full PUF: %d rows x %d columns", nrow(df), ncol(df)))

design_vars <- c("QUESTID", "QUESTID2", "ANALWT2_C", "ANALWT_C", "VESTR_C", "VESTR", "VEREP", "YEAR")
demo_mh_vars <- c("AGE3", "CATAG6", "CATAG3", "IRSEX", "NEWRACE2", "IREDUHIGHST2",
                  "EDUHIGHCAT", "INCOME", "COUTYP4", "IRINSUR4",
                  # 2023 names confirmed against the PUF: SPD recodes + raw/imputed K6 items
                  "SPDPSTMON", "SPDPSTYR", "SMIPY", "SMIPPPY",
                  "DSTNRV30", "DSTHOP30", "DSTRST30", "DSTCHR30", "DSTEFF30", "DSTNGD30",
                  "IRDSTNRV30", "IRDSTHOP30", "IRDSTRST30", "IRDSTCHR30", "IRDSTEFF30",
                  "IRDSTNGD30", "IRDSTWORST",
                  "AMDEYR", "YMDEYR", "SUICTHNK", "IRSUICTHNK")
substance_patterns <- "^(LSD|PSILCY|PEYOTE|MESC|DMTAMTFXY|ECSTMO|KETMIN|PCP|SALVIA|HALLUC|IRHALLUC|IRLSD|IRECSTMO|IRKETMIN|IRPCP)"

cols <- names(df)
keep_exact <- intersect(c(design_vars, demo_mh_vars), cols)
keep_pattern <- grep(substance_patterns, cols, value = TRUE)
keep <- unique(c(keep_exact, keep_pattern))

# Hard requirements: a weight, stratum, and replicate variable must be present.
need <- list(weight = c("ANALWT2_C", "ANALWT_C"), stratum = c("VESTR_C", "VESTR"), replicate = "VEREP")
for (nm in names(need)) {
  if (!any(need[[nm]] %in% keep))
    stop(sprintf("Required %s variable not found (looked for: %s)", nm, paste(need[[nm]], collapse = ", ")))
}
if (length(keep_pattern) == 0) stop("No substance variables matched — check substance_patterns against the codebook")

extract <- df[, ..keep]
fwrite(extract, file.path(build, "nsduh-2023-extract.csv"))

missing_exact <- setdiff(c(design_vars, demo_mh_vars), cols)
manifest <- c(
  "# NSDUH 2023 extract — generated manifest",
  "",
  sprintf("- Generated: %s", format(Sys.time(), "%Y-%m-%d %H:%M %Z")),
  sprintf("- Source file: `%s` (object `%s`)", basename(rdata[1]), objs[which(is_df)[1]]),
  sprintf("- Rows: %d (one per respondent) · Columns kept: %d of %d", nrow(extract), ncol(extract), ncol(df)),
  "",
  "## Survey design variables present",
  paste0("- `", intersect(unlist(need, use.names = FALSE), keep), "`"),
  "",
  "## Substance variables (pattern-matched)",
  paste0("- `", sort(keep_pattern), "`"),
  "",
  "## Demographic / mental-health variables present",
  paste0("- `", sort(intersect(demo_mh_vars, keep)), "`"),
  "",
  "## Candidates NOT found in this release",
  if (length(missing_exact)) paste0("- `", sort(missing_exact), "`") else "- (none)",
  "",
  "See `variables.md` for meanings and response-code caveats.")
writeLines(manifest, file.path(build, "extract-manifest.md"))
message("Wrote build/nsduh-2023-extract.csv and build/extract-manifest.md")
