#!/usr/bin/env bash
# Create the dev and test databases if missing. Uses libpq env vars (PGHOST, PGPORT, PGUSER) as usual.
set -euo pipefail
for db in "${@:-harvest_outlook_dev harvest_outlook_test}"; do
  for name in $db; do
    if psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${name}'" | grep -q 1; then
      echo "exists: ${name}"
    else
      createdb "${name}" && echo "created: ${name}"
    fi
  done
done
