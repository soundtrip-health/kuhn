#!/usr/bin/env bash
# Remove the NSDUH test database (container + data volume). The kuhn-data
# network is left in place — it is the deployment-level sandbox data network
# (SANDBOX_SECRETS_NETWORK), not fixture-specific; remove it explicitly with
# `docker network rm kuhn-data` if nothing else uses it.
set -euo pipefail
docker rm -f kuhn-nsduh-db 2>/dev/null && echo "removed container kuhn-nsduh-db" || true
docker volume rm kuhn-nsduh-data 2>/dev/null && echo "removed volume kuhn-nsduh-data" || true
