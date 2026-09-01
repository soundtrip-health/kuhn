#!/usr/bin/env bash
# Load the NSDUH 2023 extract into the kuhn-nsduh-db Postgres as
# nsduh.nsduh_2023 (one row per respondent). Requires ./fetch-nsduh.sh,
# ./make-extract.sh and ./setup-db.sh to have run. Idempotent (drops and
# reloads the table). Ends with verification queries, including proof that
# the analyst role cannot write.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
csv="$build/nsduh-2023-extract.csv"
DB_CONTAINER=kuhn-nsduh-db
[ -s "$csv" ] || { echo "Missing $csv — run ./fetch-nsduh.sh && ./make-extract.sh first" >&2; exit 1; }
docker exec "$DB_CONTAINER" pg_isready -U postgres -d nsduh >/dev/null || { echo "DB not running — run ./setup-db.sh" >&2; exit 1; }

# DDL from the CSV header: every NSDUH PUF column is numeric (coded values);
# NUMERIC handles ids and weights alike, empty cells load as NULL.
header="$(head -1 "$csv" | tr -d '\r')"
cols="$(echo "$header" | tr ',' '\n' | sed 's/^\s*//;s/\s*$//' | awk '{printf "  %s NUMERIC,\n", tolower($0)}' | sed '$ s/,$//')"

docker exec -i "$DB_CONTAINER" psql -U postgres -d nsduh -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS nsduh.nsduh_2023;
CREATE TABLE nsduh.nsduh_2023 (
$cols
);
GRANT SELECT ON nsduh.nsduh_2023 TO kuhn_analyst;
SQL

echo "Loading $(basename "$csv") …"
docker exec -i "$DB_CONTAINER" psql -U postgres -d nsduh -v ON_ERROR_STOP=1 \
  -c "\\copy nsduh.nsduh_2023 FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')" < "$csv"

echo
echo "=== Verification (superuser) ==="
docker exec "$DB_CONTAINER" psql -U postgres -d nsduh -Atc \
  "SELECT 'rows: ' || count(*) FROM nsduh.nsduh_2023;"
docker exec "$DB_CONTAINER" psql -U postgres -d nsduh -Atc \
  "SELECT 'weighted past-year hallucinogen prevalence (12+): ' ||
          round(100.0 * sum(analwt2_c * (hallucyr = 1)::int) / sum(analwt2_c), 2) || '%'
   FROM nsduh.nsduh_2023 WHERE hallucyr IN (0, 1);"

echo
echo "=== Access control (kuhn_analyst over the network) ==="
dsn="$(cat "$build/analyst-dsn.txt")"
docker run --rm --network kuhn-data postgres:16-alpine \
  psql "$dsn" -Atc "SELECT 'analyst SELECT ok: ' || count(*) FROM nsduh.nsduh_2023;"
if docker run --rm --network kuhn-data postgres:16-alpine \
    psql "$dsn" -Atc "INSERT INTO nsduh.nsduh_2023 (questid2) VALUES (0);" 2>/dev/null; then
  echo "ERROR: analyst role could INSERT into the data schema — access control is broken" >&2; exit 1
else
  echo "analyst INSERT into nsduh correctly refused (read-only data schema)"
fi
docker run --rm --network kuhn-data postgres:16-alpine psql "$dsn" -v ON_ERROR_STOP=1 -Atc "
  CREATE TEMP TABLE t_smoke AS SELECT 1 AS ok;
  DROP TABLE IF EXISTS sandbox.smoke_check;
  CREATE TABLE sandbox.smoke_check AS
    SELECT hallucyr, count(*) AS n FROM nsduh.nsduh_2023 GROUP BY 1;
  SELECT 'analyst scratch writes ok: sandbox.smoke_check rows=' || count(*) FROM sandbox.smoke_check;
  DROP TABLE sandbox.smoke_check;"
echo
echo "Done. Next: create the org secret 'nsduh-db' with the DSN in build/analyst-dsn.txt (see ../README.md §Setup)."
