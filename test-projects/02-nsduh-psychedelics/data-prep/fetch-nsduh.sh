#!/usr/bin/env bash
# Download the 2023 NSDUH public-use file (R bundle, ~40 MB) from SAMHSA into
# build/. Public-domain US-government data; see ../README.md for the citation.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
mkdir -p "$build"
url="https://www.samhsa.gov/data/system/files/media-puf-file/nsduh-2023-ds0001-bndl-data-r_v2.zip"
zip="$build/nsduh-2023-r.zip"
if [ ! -s "$zip" ]; then
  echo "Downloading $url"
  curl -fL --retry 3 -o "$zip" "$url"
else
  echo "Reusing existing $zip"
fi
unzip -o "$zip" -d "$build"
echo "Contents of $build:"
find "$build" -maxdepth 2 -type f | sed "s|$build/||"
echo
echo "Next: ./make-extract.sh"
