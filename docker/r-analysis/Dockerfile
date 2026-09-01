# Kuhn analyst R runtime (issue #68b). Runs inside the no-network sandbox
# (sandbox.js: --network none, project read-only, /out the only writable
# mount), so EVERY package the analyst may need must be baked in here —
# install.packages() cannot work at run time, by design (see
# docs/security/threat-model.md).
#
# Build (from the repo root):
#   docker build -t kuhn/r-analysis:latest docker/r-analysis
#
# Override the image name via SANDBOX_R_IMAGE. See README.md in this
# directory for the package-request path.

FROM rocker/r-ver:4.4

# install2.r ships with rocker; --error fails the build on any install
# failure instead of producing an image with a silently missing package.
# One layer per theme keeps rebuilds after an append cheap-ish.

# Modeling: GAMMs (the issue's flagship case), mixed models, survival.
RUN install2.r --error --skipinstalled \
    mgcv gamm4 lme4 nlme survival broom broom.mixed

# Data handling and IO.
RUN install2.r --error --skipinstalled \
    data.table janitor readxl haven arrow jsonlite

# tidyverse (large; kept in its own layer) and plotting extras.
RUN install2.r --error --skipinstalled \
    tidyverse patchwork ggrepel scales

# Complex-survey analysis (NSDUH-style weighted estimates — test-projects/02).
RUN install2.r --error --skipinstalled \
    survey srvyr

# Database clients (org-secrets feature: secrets-enabled runs reach org data
# services over the internal sandbox network). RPostgres needs libpq to build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev \
    && rm -rf /var/lib/apt/lists/*
RUN install2.r --error --skipinstalled \
    DBI RPostgres

CMD ["R", "--version"]
