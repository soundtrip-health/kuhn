#!/usr/bin/env bash
# Run prepare-analysis-extract.R inside the analyst sandbox image (no host R
# needed). Produces build/nsduh-2023-extract.csv + build/extract-manifest.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
image="${SANDBOX_R_IMAGE:-kuhn/r-analysis:latest}"
docker run --rm --network none \
  -v "$here:/work" -w /work \
  "$image" Rscript prepare-analysis-extract.R
echo
echo "Done. Upload build/nsduh-2023-extract.csv, build/extract-manifest.md and"
echo "variables.md at the setup wizard's uploads step (see ../prompts.md §1)."
