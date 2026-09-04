#!/usr/bin/env bash
# Stand up the NSDUH Postgres "org data service" for the Kuhn E2E test:
#   - an INTERNAL docker network (kuhn-data): containers on it can talk to
#     each other, but there is NO route to the outside — this is the network
#     secrets-enabled analyst runs join (SANDBOX_SECRETS_NETWORK), so the
#     no-internet sandbox invariant holds.
#   - a postgres:16-alpine container (kuhn-nsduh-db) reachable ONLY on that
#     network (not from the host, not from the internet).
#   - access control (the pattern to copy for a REAL warehouse — see
#     ../README.md "Using this as a deployment guide"): one role `kuhn_analyst`
#     with SELECT-only on the data schema (nsduh) and USAGE+CREATE on a
#     scratch schema (sandbox) for intermediate/cohort tables, plus TEMP
#     tables. The postgres superuser stays inside the container (docker exec)
#     and is never given to agents.
# Idempotent: safe to re-run. Teardown: ./teardown-db.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
mkdir -p "$build"

NET=kuhn-data
DB_CONTAINER=kuhn-nsduh-db
DB_VOLUME=kuhn-nsduh-data

# 1. Internal network (idempotent). --internal = no external connectivity.
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create --internal "$NET"
  echo "Created internal docker network: $NET"
else
  internal=$(docker network inspect -f '{{.Internal}}' "$NET")
  if [ "$internal" != "true" ]; then
    echo "ERROR: docker network '$NET' exists but is not internal." >&2
    echo "Remove it (docker network rm $NET) or set SANDBOX_SECRETS_NETWORK to an internal one." >&2
    exit 1
  fi
  echo "Internal docker network already present: $NET"
fi

# 2. Analyst password (generated once, kept under gitignored build/).
pw_file="$build/analyst-password.txt"
if [ ! -s "$pw_file" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24 > "$pw_file"
  echo >> "$pw_file"
fi
ANALYST_PW="$(head -1 "$pw_file")"

# 3. Postgres container on the internal network only.
if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  docker run -d --name "$DB_CONTAINER" \
    --network "$NET" \
    -v "$DB_VOLUME:/var/lib/postgresql/data" \
    -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)" \
    -e POSTGRES_DB=nsduh \
    postgres:16-alpine
  echo "Started $DB_CONTAINER (postgres:16-alpine) on $NET"
else
  docker start "$DB_CONTAINER" >/dev/null
  echo "Container already present: $DB_CONTAINER"
fi

# pg_isready answers during the image's throwaway init server too — wait for
# a real query against the nsduh database instead.
echo -n "Waiting for postgres"
ready=0
for _ in $(seq 1 60); do
  if docker exec "$DB_CONTAINER" psql -U postgres -d nsduh -Atc 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  echo -n "."; sleep 1
done
[ "$ready" = 1 ] || { echo " TIMED OUT — check: docker logs $DB_CONTAINER" >&2; exit 1; }
echo " ready."

# 4. Access control: read-only analyst role, locked to schema nsduh.
docker exec -i "$DB_CONTAINER" psql -U postgres -d nsduh -v ON_ERROR_STOP=1 -v pw="$ANALYST_PW" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kuhn_analyst') THEN
    CREATE ROLE kuhn_analyst LOGIN;
  END IF;
END $$;
ALTER ROLE kuhn_analyst PASSWORD :'pw';
CREATE SCHEMA IF NOT EXISTS nsduh;
CREATE SCHEMA IF NOT EXISTS sandbox;
-- Lock the defaults down first: no CREATE on public for anyone.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- Data schema: read-only — usage + select, nothing else.
GRANT USAGE ON SCHEMA nsduh TO kuhn_analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA nsduh TO kuhn_analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA nsduh GRANT SELECT ON TABLES TO kuhn_analyst;
-- Scratch schema: analysts routinely stage intermediate/cohort tables. They
-- own what they create there (full rights on their own tables); the data
-- schema stays immutable. TEMP allows session-local temp tables too.
GRANT USAGE, CREATE ON SCHEMA sandbox TO kuhn_analyst;
GRANT TEMPORARY ON DATABASE nsduh TO kuhn_analyst;
SQL

# 5. The DSN the org secret will carry (host = container name on kuhn-data).
dsn="postgresql://kuhn_analyst:${ANALYST_PW}@${DB_CONTAINER}:5432/nsduh"
echo "$dsn" > "$build/analyst-dsn.txt"
echo
echo "Read-only analyst DSN written to build/analyst-dsn.txt"
echo "Next: ./load-nsduh.sh  (then create the org secret — see ../README.md)"
