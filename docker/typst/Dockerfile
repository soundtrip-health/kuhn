# Kuhn Typst renderer: the official typst image plus the metric-compatible
# font families that grant and journal templates ask for. The stock image
# ships only Libertinus / New Computer Modern / DejaVu Mono, so an "Arial 11pt"
# template (NIH) would silently fall back to a serif with different metrics —
# and pagination (page-limit checks) would be wrong. With --network none there
# is no runtime font download, so the fonts are baked in.
#
#   docker build -t kuhn/typst:latest docker/typst
#
# Families added (all free, metric clones of the proprietary originals):
#   Liberation Sans/Serif/Mono   → Arial / Times New Roman / Courier New
#   Carlito / Caladea            → Calibri / Cambria
#   URW base35 (Nimbus Sans/Roman, P052, …) → Helvetica / Times / Palatino
#   DejaVu Sans/Serif            → wide Unicode coverage fallback
FROM debian:bookworm-slim AS fonts
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
      fonts-urw-base35 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

FROM ghcr.io/typst/typst:latest
COPY --from=fonts /usr/share/fonts /usr/share/fonts
