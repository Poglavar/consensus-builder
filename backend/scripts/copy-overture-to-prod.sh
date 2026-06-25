#!/usr/bin/env bash
# Copies the locally-ingested overture_feature table to a remote/prod Postgres. Prod has no DuckDB,
# so the workflow is: ingest locally (scripts/ingest-overture.js, needs DuckDB) → copy the one table
# up with this script. Because every Overture layer lives in the single overture_feature table, this
# is one dump → one restore, regardless of how many layers you've ingested.
#
# It dumps from the LOCAL docker Postgres using that server's own pg_dump (version-matched) and pipes
# a self-contained SQL stream (schema + data, DROP/CREATE) into the target you provide. The table is
# fully replaced on the target each run (idempotent).
#
# Usage:
#   PROD_DATABASE_URL='postgres://user:pass@host:5432/dbname' ./scripts/copy-overture-to-prod.sh
#
# Optional overrides (defaults match local dev):
#   LOCAL_CONTAINER=consensus-builder-db-1  LOCAL_USER=zagreb_user  LOCAL_DB=zagreb
#
# NOTE: this writes to whatever PROD_DATABASE_URL points at — double-check it's the intended target.

set -euo pipefail

: "${PROD_DATABASE_URL:?Set PROD_DATABASE_URL to the target Postgres connection string}"
LOCAL_CONTAINER="${LOCAL_CONTAINER:-consensus-builder-db-1}"
LOCAL_USER="${LOCAL_USER:-zagreb_user}"
LOCAL_DB="${LOCAL_DB:-zagreb}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "[$(ts)] Dumping overture_feature from ${LOCAL_DB} (container ${LOCAL_CONTAINER}) → target ${PROD_DATABASE_URL%%\?*}"

# --clean --if-exists: DROP TABLE IF EXISTS then recreate + reload, so a re-run fully replaces the
# table (and its indexes) on the target. --no-owner/--no-acl: don't carry local roles to prod.
docker exec -i "${LOCAL_CONTAINER}" \
    pg_dump -U "${LOCAL_USER}" -d "${LOCAL_DB}" \
    --table=overture_feature --clean --if-exists --no-owner --no-acl \
  | psql "${PROD_DATABASE_URL}"

echo "[$(ts)] Done. Verify on the target:"
echo "  psql \"\$PROD_DATABASE_URL\" -c \"SELECT city, layer, count(*) FROM overture_feature GROUP BY 1,2 ORDER BY 1,2;\""
