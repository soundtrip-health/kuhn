# Reproducible Robotics Experiment Reporting

> **Kuhn knowledge card.** Canonical source: https://www.nist.gov/publications/benchmarking-protocols-evaluating-small-parts-robotic-assembly-systems (NIST). Source access/license: NIST publications are public domain (U.S. Government work); the companion MIRRER framework is an open-access arXiv preprint. This card is a Kuhn-authored summary — cite and consult the canonical sources for authoritative text.

## Scope

How to report robotics experiments so other groups can reproduce, replicate, or fairly
compare them. Applies to manipulation, mobile-robot/SLAM, and robot-learning papers; to
reproducible-article tracks (e.g., IEEE RAM R-articles) and journals requiring
experimental validation (T-FR rejects simulation-only claims); and to benchmark or
evaluation studies. Draws on NIST benchmarking protocols (public domain), the MIRRER
framework (Multiple Iterated, Reproduced, and Replicated Experiments with Robots), and
community best practice for sim-to-real reporting.

## Key requirements

**Hardware specification**

- Identify the robot make, model, and firmware/controller version; the end-effector and
  any tooling; sensor models, mounting poses, and calibration procedure; and the compute
  hardware used at runtime.
- Report payload, workspace, and control rates where they bound performance.
- For field work, characterize the environment (terrain, lighting, weather). MIRRER
  points to ASTM F3218-19 / F3381-19-style environment and test-object characterization
  so that "the same task" means the same physical conditions.

**Software specification**

- Name the OS, middleware (e.g., ROS distribution), key library versions, and the exact
  code version — commit hash or archived release DOI (Code Ocean or a tagged GitHub
  release, as IEEE RAM's reproducible-article track requires).
- Record controller gains, planner parameters, random seeds, and training hyperparameters.
- Distinguish what was learned or tuned per-environment from what was fixed.

**Benchmarks and metrics**

- Prefer community-standard metrics over bespoke ones: task success rate with the success
  criterion stated precisely; cycle/completion time; precision or force-based measures.
- For SLAM and navigation, report Absolute Trajectory Error (ATE) and Relative Pose Error
  (RPE) against ground truth of stated quality.
- For assembly and manipulation, use NIST task-board protocols (peg-in-hole insertions,
  connector mating, small-parts assembly) with their force/torque-based metrics — they
  enable cross-lab comparison on identical physical artifacts.
- Report the number of trials and how trials were selected; no silent discarding of
  failed runs.

**Statistics**

- Robotics results are high-variance; single-run numbers are anecdotes.
- Report distributions: mean with standard deviation or confidence intervals across ≥10
  trials (sim-to-real best-practice literature suggests bootstrapped standard deviations
  across at least 10 evaluation runs).
- For learned policies, report per-seed results and the exact checkpoint evaluated.
- Use statistical tests when claiming one method beats another.

**Sim-to-real reporting**

- State the simulator and version, physics-engine parameters, and every
  domain-randomization range.
- Report sim and real performance separately — never blended into one number — and
  quantify the transfer gap.
- Describe real-world evaluation conditions in the same detail as training conditions,
  including perception inputs (camera resolution, latency) and any human interventions
  or resets during runs.

**Reproducibility levels (MIRRER framing)**

- Distinguish *repeatability* (same team, same setup), *reproducibility* (different team,
  same artifacts/protocol), and *replicability* (different team, independent
  implementation).
- State which level your released artifacts support and what a reader needs to reach it.

## How to apply when writing

- Write the experimental-setup section as a build sheet: platform, sensors, compute,
  software versions, parameters — enough that a competent lab could re-stage the
  experiment without emailing you.
- State the protocol before the results: number of trials, initial-condition
  distribution, reset procedure, success criterion, abort/intervention rules.
- Use a standard benchmark where one exists (NIST task boards, established SLAM datasets)
  and cite its protocol; enumerate any deviations.
- Tabulate results as mean ± dispersion with n stated; show failure cases and count
  interventions, not just highlight reels.
- Release code, configuration files, and logged data with a persistent identifier, cite
  them in the paper, and note the license and any hardware required to rerun.
- For sim-to-real work, include a table with matched sim and real metrics side by side.

## Common pitfalls

- "We used a UR5 and ROS" as the entire setup description — missing versions, gains,
  calibration, and sensor placement.
- Success rates from a handful of hand-picked runs: no trial count, no variance,
  discarded failures unreported.
- Bespoke metrics that preclude comparison when a NIST protocol or ATE/RPE convention
  already exists for the task.
- Sim-to-real claims with undocumented randomization ranges, real-world conditions, or
  human interventions, making the transfer gap unmeasurable.
- Code links that rot: unpinned repositories with no commit hash, DOI, or archived release.
- Conflating repeatability with reproducibility — claiming "reproducible" when only the
  original rig can rerun the experiment.

## Canonical links

- https://www.nist.gov/publications/benchmarking-protocols-evaluating-small-parts-robotic-assembly-systems — NIST small-parts robotic assembly benchmarking protocols
- https://arxiv.org/html/2408.04736 — MIRRER framework (reproduced/replicated robot experiments)
- https://www.ieee-ras.org/publications/ram/information-for-authors/ — IEEE RAM reproducible-article (R-article) guidelines
- https://www.ieee-ras.org/publications/ra-l/special-issues/past-special-issues/benchmarking-protocols-for-robotic-manipulation/ — RA-L benchmarking-protocols special issue
