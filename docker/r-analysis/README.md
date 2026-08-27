# kuhn/r-analysis — the analyst's R runtime

The image the `run_script` tool uses for R scripts (issue #68b). It is
**Kuhn-built, not pulled**: the sandbox runs with `--network none` (a
threat-model invariant), so there are no runtime package installs — the
curated package set in the [Dockerfile](Dockerfile) is everything an analyst
script can use.

## Build

```bash
docker build -t kuhn/r-analysis:latest docker/r-analysis
```

Deployments that want a pinned tag can build `kuhn/r-analysis:<date>` and
point `SANDBOX_R_IMAGE` at it (`agent-backend` config).

## Requesting a package

"Install as needed" becomes a request, deliberately:

1. Open an issue (or PR) adding the package to the appropriate `install2.r`
   layer in the Dockerfile — say which analysis needs it.
2. Rebuild the image and redeploy (`docker build …` on the host that runs
   the backend; no backend restart needed — the next `run_script` picks up
   the new image).

Keep the set curated: every addition is code that runs against tenant data,
and image size is deployment cost (rocker + tidyverse is already ~2 GB).

## Contract for scripts

- The project is mounted read-only at `/work` (the working directory);
  inputs are workspace-relative paths.
- Write every output under `$OUT_DIR` (the only writable mount). The backend
  copies it into the project at `analyst/output/run-<id>/`.
- No network. Exit non-zero with a message on stderr when inputs are
  unusable.
