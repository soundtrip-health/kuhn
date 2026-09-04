#!/usr/bin/env bash
# Collect the four seed documents for the Kuhn-manuscript test project from the
# repo's own docs into ./seed-docs-upload/, ready to drag into the setup
# wizard's uploads step. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/seed-docs-upload"
mkdir -p "$out"
cp "$repo/README.md" "$out/README.md"
cp "$repo/docs/data-pipeline.md" "$out/data-pipeline.md"
cp "$repo/docs/design/ui-design-brief.md" "$out/ui-design-brief.md"
cp "$repo/docs/specs/065-general-knowledge-library.md" "$out/065-general-knowledge-library.md"
echo "Seed docs ready in $out:"
ls -1 "$out"
