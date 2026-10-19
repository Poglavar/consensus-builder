#!/usr/bin/env bash
# Copies ONE region's locally-ingested Overture buildings to a remote/prod Postgres. Prod has no
# DuckDB, so the workflow is: ingest locally in cadastre-data
# (`node buildings/fetch-overture-buildings.js --run --city <region>`) → push that region up here.
#
# Region-scoped ON PURPOSE. The old version of this script dumped a whole table with
# `pg_dump --clean`, which was safe while the table was this app's private `overture_feature`. It is
# not safe now: `public.overture_building_footprint` is SHARED with cadastre-data and
# zagreb-isochrone and holds regions this repo never ingests (zagreb, rijeka, rail-corridor pulls).
# A DROP/CREATE from here would delete every one of them on the target. So we replace only the rows
# for the region named.
#
# Usage:
#   PROD_DATABASE_URL='postgres://user:pass@host:5432/geodata' \
#     ./scripts/copy-overture-to-prod.sh <region>
#
# <region> is the `city` value in overture_building_footprint — the `region` field in
# backend/buildings/overture-cities.js (e.g. sjeverna-dalmacija, split, belgrade).
#
# Optional overrides (defaults match local dev):
#   LOCAL_CONTAINER=consensus-builder-db-1  LOCAL_USER=zagreb_user  LOCAL_DB=geodata
#
# NOTE: this writes to whatever PROD_DATABASE_URL points at — double-check it's the intended target.

set -euo pipefail

REGION="${1:-}"
if [ -z "$REGION" ]; then
    echo "Usage: PROD_DATABASE_URL=... $0 <region>" >&2
    echo "  <region> is the overture_building_footprint.city value, e.g. sjeverna-dalmacija" >&2
    exit 1
fi

: "${PROD_DATABASE_URL:?Set PROD_DATABASE_URL to the target Postgres connection string}"
LOCAL_CONTAINER="${LOCAL_CONTAINER:-consensus-builder-db-1}"
LOCAL_USER="${LOCAL_USER:-zagreb_user}"
LOCAL_DB="${LOCAL_DB:-geodata}"
TABLE=overture_building_footprint

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

LOCAL_COUNT=$(docker exec -i "${LOCAL_CONTAINER}" \
    psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -tAc \
    "SELECT count(*) FROM ${TABLE} WHERE city = '${REGION}'" | tr -d '[:space:]')

if [ "${LOCAL_COUNT}" = "0" ]; then
    echo "[$(ts)] Refusing to run: local ${TABLE} has no rows for region '${REGION}'." >&2
    echo "         Pushing an empty region would delete it on the target. Ingest it first." >&2
    exit 1
fi

echo "[$(ts)] Copying ${LOCAL_COUNT} '${REGION}' rows from ${LOCAL_DB} (container ${LOCAL_CONTAINER})"
echo "[$(ts)] Target: ${PROD_DATABASE_URL%%\?*}"

# Stream the region's rows as a text COPY into a staging table on the target, then swap that region
# across inside ONE transaction, so a failed run leaves the target untouched rather than half
# replaced. ON_ERROR_STOP makes psql abort (and roll back) on the first error instead of carrying on.
docker exec -i "${LOCAL_CONTAINER}" \
    psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" \
    -c "\\copy (SELECT * FROM ${TABLE} WHERE city = '${REGION}') TO STDOUT" \
  | psql "${PROD_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "
        BEGIN;
        CREATE TEMP TABLE _ovt_stage (LIKE ${TABLE} INCLUDING DEFAULTS) ON COMMIT DROP;
        COPY _ovt_stage FROM STDIN;
        DELETE FROM ${TABLE} WHERE city = '${REGION}';
        INSERT INTO ${TABLE} SELECT * FROM _ovt_stage;
        COMMIT;"

echo "[$(ts)] Done. Verify on the target:"
echo "  psql \"\$PROD_DATABASE_URL\" -c \"SELECT city, count(*) FROM ${TABLE} GROUP BY 1 ORDER BY 1;\""
