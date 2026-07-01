#!/usr/bin/env bash
# Idempotent telemetry DB setup on existing oan_postgres container.
# Usage on sandbox:
#   export POSTGRES_PASSWORD='your-password-from-.env.infra'
#   bash database/telemetry-setup-existing-postgres.sh
set -euo pipefail

CONTAINER="${POSTGRES_CONTAINER:-oan_postgres}"
PGUSER="${POSTGRES_USER:-postgres}"
DB_NAME="${TELEMETRY_DB:-vistaar_telemetry}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "Set POSTGRES_PASSWORD first (from deploy/.env.infra on the server)."
  exit 1
fi

exec_psql() {
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PGUSER" "$@"
}

echo "==> Checking Postgres container: $CONTAINER"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"

echo "==> Checking database: $DB_NAME"
exists="$(exec_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
if [[ "$exists" != "1" ]]; then
  echo "    Creating database $DB_NAME ..."
  exec_psql -d postgres -c "CREATE DATABASE $DB_NAME;"
else
  echo "    Database already exists."
fi

echo "==> Creating raw tables (winston_logs, telemetry_etl_state) ..."
exec_psql -d "$DB_NAME" -f - < "$SCRIPT_DIR/telemetry-docker-init.sql"

flat_exists="$(exec_psql -d "$DB_NAME" -tAc "SELECT to_regclass('public.provider_telemetry_events')")"
if [[ -z "$flat_exists" ]]; then
  echo "==> Creating flat table + indexes ..."
  exec_psql -d "$DB_NAME" -f - < "$SCRIPT_DIR/provider-telemetry-events.sql"
else
  echo "    provider_telemetry_events already exists — skipping (won't DROP data)."
fi

echo "==> Verifying tables ..."
exec_psql -d "$DB_NAME" -c "\dt"

echo "Done. Connection string:"
echo "postgresql://${PGUSER}:****@127.0.0.1:5432/${DB_NAME}"