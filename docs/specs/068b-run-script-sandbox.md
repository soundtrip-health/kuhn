# Spec: run_script — sandboxed analyst execution + R (issue #68, part b)

**Status:** implemented (this spec ships with the implementation)
**Issue:** [#68 — shared scripts](https://github.com/rfdougherty/kuhn/issues/68)
**Antecedents:** the shared script library (`068a`), the sandbox wrapper
(story 018 — `sandbox.js`, "future analyst Python execution must use the same
wrapper"), ADR 002 §6 (server-chosen images/argv), threat model B16/T-22/T-24.

Part a built the library; this part makes it run: the analyst gets
`list_scripts` + `run_script`, the sandbox gets an R runtime, and every run
leaves a provenance record. This is the first time any Kuhn agent executes
code.

## 1. Goal

An analyst that can actually run the deterministic path: prefer a shared,
reviewed org script; iterate on project-local R scripts; produce
tables/figures that land in the project with full provenance — all inside the
existing sandbox posture.

### Decisions (settled with the maintainer)

- **`--network none` stays inviolate.** R packages come from a prebuilt,
  Kuhn-**built** image (`docker/r-analysis/Dockerfile`: `rocker/r-ver:4.4` +
  mgcv/gamm4/lme4/nlme/survival/broom/data.table/janitor/readxl/haven/arrow/
  tidyverse/patchwork/…). "Install as needed" becomes a documented
  package-request path: edit the Dockerfile, rebuild, redeploy.
- **R only in v1.** `.py` scripts can be stored/promoted (068a) but
  `run_script` refuses them with a message naming the request path.

### Non-goals

Runtime package installation or any network egress; Python execution;
granting `run_script` beyond the analyst; a human-facing "run" button in the
UI; putting render/ingest behind the new concurrency cap (explicit follow-up).

## 2. Design

### Sandbox (`sandbox.js`)

`buildDockerArgs` gains `extraMounts` / `env` / per-run `cpus`+`memory` —
every value composed server-side, `--network none` unconditional (asserted in
tests). New `runScriptSandboxed(projectId, {language, entrypoint, args,
scriptContent | scriptRelPath})`:

- Org-library code is materialized into a temp dir under
  `<projectsRoot>/.script-tmp/` (same macOS bind-mount rationale as
  `.render-tmp`) and mounted read-only at `/script`; project-local scripts run
  in place from the read-only `/work` mount.
- `OUT_DIR=/out` is the output contract: scripts write only there.
- Interpreter argv is keyed on language (`r` → `Rscript <entry> <args…>`);
  the model chooses only the script selector and its args.
- Nonzero exits return (with stderr) rather than throw — the agent needs
  them; timeouts/docker failures still raise `SandboxError`.
- Outputs are collected recursively from `/out`, capped at
  `SCRIPT_MAX_OUTPUT_FILES` / `SCRIPT_MAX_OUTPUT_BYTES` with the skipped
  count reported.

Limits (`config.sandbox.script`, env-overridable): 300 s, 2 CPUs, 2 GB,
64 MB output — a GAMM fit outgrows the render defaults.

### Concurrency (threat model T-22, minimal)

`sandbox-semaphore.js`: an in-process FIFO semaphore
(`SCRIPT_MAX_CONCURRENT`, default 2) wraps every `run_script` execution.

### Agent tools (`agents/runtime.js`, DB slug `run_script`, analyst-only)

- `list_scripts` — the org's active scripts with their args contracts (org
  derived server-side from the project, as with `search_org_knowledge`).
- `run_script` — `script` (org slug, current version) XOR `path`
  (project-relative, for pre-promotion iteration); `args` limited to 16
  strings matching `[\w./=@,:-]+` (no whitespace/shell metacharacters; argv
  position after the entrypoint means they can never become docker or
  interpreter flags).
- Outputs are copied into `analyst/output/run-<jobId>-<seq>/` **through
  `storage.js`** (path containment + 20 MB/file cap), each copy publishing a
  real `file_change` so badges/activity/version history see it. That
  directory is outside `draft/**`, so suggestion mode does not intercept.
- The tool result carries exit code, duration, copied paths, and
  stdout/stderr tails (~16 KB); nonzero exits are `isError`.

### Provenance

`script_runs` (append-only): project, job, org script + version or project
path, args, status (`ok`/`error`/`timeout`/`failed`), exit code, duration,
output dir, stdout/stderr tails. Recording is non-throwing (auth-events
discipline). `GET /api/projects/:id/script-runs` (viewer) serves the log.

### Prompts

`analyst.md` gains a "Running Code — the deterministic path" section
(library-first, sandbox contract, promote-what's-reusable). The stale
CLI-era `scripts/read_sections.py` / `.venv` instructions in
writer/reviewer/ra/pm are replaced with file-tool equivalents — those
references were exactly the "known-working scripts" the CLI era lost.

### Flagship script

`shared-scripts/r/gamm-smooth-trends` (catalog v1): GAMM of an outcome over
a continuous predictor with an optional random-intercept group; writes
`model_summary.txt`, tidy term tables, a population fitted curve with 95%
CI, and a diagnostic plot — the issue's motivating example, runnable end to
end.

## 3. Security posture (threat model T-42)

Model-authored code runs against the tenant's own project data inside the
B16 container: no network, no credentials, read-only project, capped
resources. Escape = T-24 (container 0-day), unchanged. The image and argv
stay server-chosen (ADR 002 §6-compatible); org scripts are owner-reviewed
at promotion; outputs re-enter only through storage.js. T-25 (web process
holds docker) is unchanged and remains the central topology finding.

## 4. Files

`sandbox.js`, `sandbox-semaphore.js` (+ tests incl. `sandbox-script.test.js`),
`config.js`, `agents/runtime.js` (+ tests), `db/schema.sql` (`script_runs`),
`db/script-runs.js` (+ test), `db/seed-data.js` (tool + analyst assignment),
`routes/projects.js` (script-runs listing), `docker/r-analysis/`,
`shared-scripts/` (GAMM script), `db/prompts/*.md`, docs (README, AGENTS.md,
deployment, data-pipeline, backend README, threat model).

## 5. Deferred

Python runtime; render/ingest concurrency adoption; a script-runs UI panel;
per-tenant execution quotas (T-21/T-22 remainder); digest-pinned images
(T-26); the isolated sandbox service (ADR 002 §6 / STH-21).
