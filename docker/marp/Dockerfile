# STH-61: Kuhn's Marp image — the official marp-cli image (Chromium bundled)
# plus LibreOffice Impress, which `--pptx-editable` requires. Built, not
# pulled (the r-analysis precedent):
#
#   docker build -t kuhn/marp:latest docker/marp
#
# The sandbox runs it with --network none; everything needed is baked in.
FROM marpteam/marp-cli:latest

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-impress \
  && rm -rf /var/lib/apt/lists/*
