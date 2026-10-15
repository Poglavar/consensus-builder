#!/usr/bin/env bash
# Copies the locally built floor-plan site models (floor_plan.site_model) to production. Collection
# and paid readings run on the laptop (production collection is stopped), so production cannot build
# these; it only serves them to the archive page's Sites tab. The table is derived, so prod's set is
# REPLACED by the local one in one transaction: a site no longer located disappears there too.
# Only retained originals referenced by public apartment models are copied, with hash verification.
#
# Usage:
#   backend/scripts/push-site-models-to-prod.sh          # compare local and prod, change nothing
#   backend/scripts/push-site-models-to-prod.sh --run    # replace prod's site models, then read back
#
# Local connection: DATABASE_URL from backend/.env (the laptop database).
# Prod: `ssh $SSH_HOST` (default do), psql as postgres with SET ROLE geo_user.

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${SSH_HOST:-do}"
RUN=0
case "${1:-}" in
    --run) RUN=1 ;;
    "") ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# shellcheck disable=SC1091
set -a; . "$BACKEND_DIR/.env"; set +a
: "${DATABASE_URL:?DATABASE_URL is not set in backend/.env}"
PROD_PSQL="sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 geodata"
LIST_SQL="SELECT site_key || ' ' || model_hash FROM floor_plan.site_model"
# comm needs both lists in one byte order, whatever collation either database uses.
export LC_ALL=C

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "$LIST_SQL" | sort > "$work/local"
ssh "$SSH_HOST" "$PROD_PSQL -At -c \"$LIST_SQL\"" | sort > "$work/prod"

report() {
    local local_n prod_n added removed changed
    local_n=$(wc -l < "$work/local" | tr -d ' ')
    prod_n=$(wc -l < "$work/prod" | tr -d ' ')
    added=$(comm -23 <(cut -d' ' -f1 "$work/local") <(cut -d' ' -f1 "$work/prod") | wc -l | tr -d ' ')
    removed=$(comm -13 <(cut -d' ' -f1 "$work/local") <(cut -d' ' -f1 "$work/prod") | wc -l | tr -d ' ')
    changed=$(( $(comm -23 "$work/local" "$work/prod" | wc -l) - added ))
    echo "[$(ts)] $1: local ${local_n}, prod ${prod_n}; to add ${added}, to remove ${removed}, changed ${changed}"
}
report "site models"

[ -s "$work/local" ] || { echo "[$(ts)] Refusing: no local site models — pushing would empty production's set." >&2; exit 1; }
[ "$RUN" -eq 1 ] || { echo "[$(ts)] DRY RUN — pass --run to replace production's site models"; exit 0; }

# Verify selected plan originals locally before any publication. No HTML or gallery cache travels.
(
cd "$BACKEND_DIR"
node --input-type=module - "$work" <<'JS'
import { createClient } from './db/connection.cjs';
import { writeFile } from 'node:fs/promises';
import { archiveRoot, readBlobRow } from './floor-plans/blob-store.js';
const dir=process.argv[2], db=createClient();
await db.connect();
try {
 const rows=(await db.query(`SELECT b.* FROM floor_plan.blob b WHERE b.bytes_available AND EXISTS(
  SELECT 1 FROM floor_plan.site_model m,jsonb_array_elements(COALESCE(m.model#>'{inventory,apartments}','[]')) a
  WHERE a#>>'{source,sha256}'=b.sha256) ORDER BY b.sha256`)).rows;
 for(const row of rows)await readBlobRow(row);
 await writeFile(`${dir}/source-root`,archiveRoot());
 await writeFile(`${dir}/source-paths`,rows.map(r=>r.storage_path).join('\n')+(rows.length?'\n':''));
 await writeFile(`${dir}/source-checks`,rows.map(r=>`${r.sha256}  ${r.storage_path}`).join('\n')+(rows.length?'\n':''));
 console.log(`Verified ${rows.length} selected plan originals (${rows.reduce((n,r)=>n+Number(r.byte_count),0)} bytes).`);
} finally {await db.end();}
JS
)
if [[ -s "$work/source-paths" ]]; then
    source_root="$(cat "$work/source-root")"
    COPYFILE_DISABLE=1 tar -C "$source_root" -czf - -T "$work/source-paths" | ssh "$SSH_HOST" \
        'mkdir -p "$HOME/code/consensus-builder/data/floor-plan-downloads" && tar -xzf - -C "$HOME/code/consensus-builder/data/floor-plan-downloads"'
    ssh "$SSH_HOST" 'cd "$HOME/code/consensus-builder/data/floor-plan-downloads" && sha256sum -c -' < "$work/source-checks"
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "\\copy (SELECT b.sha256,b.media_type,b.byte_count,b.storage_path FROM floor_plan.blob b WHERE b.bytes_available AND EXISTS(SELECT 1 FROM floor_plan.site_model m,jsonb_array_elements(COALESCE(m.model#>'{inventory,apartments}','[]')) a WHERE a#>>'{source,sha256}'=b.sha256)) TO STDOUT" \
      | ssh "$SSH_HOST" "$PROD_PSQL -c 'SET ROLE geo_user' \
          -c 'CREATE TEMP TABLE public_source_push (sha256 text,media_type text,byte_count bigint,storage_path text)' \
          -c '\\copy public_source_push FROM STDIN' \
          -c 'INSERT INTO floor_plan.blob(sha256,media_type,byte_count,storage_path,bytes_available,stored_at)
              SELECT sha256,media_type,byte_count,storage_path,true,now() FROM public_source_push
              ON CONFLICT(sha256) DO UPDATE SET media_type=excluded.media_type,byte_count=excluded.byte_count,
                storage_path=excluded.storage_path,bytes_available=true,stored_at=now(),discarded_at=NULL,discard_reason=NULL,updated_at=now()'"
fi

# One psql session on prod: stage into a temp table, then delete-and-upsert in ONE implicit
# transaction (a multi-statement -c string), so a failure leaves prod's previous set intact.
# built_at is the local build time (when the model was derived); created_at/updated_at are prod's own.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT site_key, listing_urls, model, model_hash, built_at FROM floor_plan.site_model) TO STDOUT" \
  | gzip -1 \
  | ssh "$SSH_HOST" "gunzip | $PROD_PSQL \
      -c 'SET ROLE geo_user' \
      -c 'CREATE TEMP TABLE site_model_push AS SELECT site_key, listing_urls, model, model_hash, built_at FROM floor_plan.site_model WITH NO DATA' \
      -c '\\copy site_model_push FROM STDIN' \
      -c 'DELETE FROM floor_plan.site_model m WHERE NOT EXISTS (SELECT 1 FROM site_model_push p WHERE p.site_key = m.site_key);
          INSERT INTO floor_plan.site_model (site_key, listing_urls, model, model_hash, built_at)
          SELECT site_key, listing_urls, model, model_hash, built_at FROM site_model_push
          ON CONFLICT (site_key) DO UPDATE SET listing_urls = excluded.listing_urls, model = excluded.model,
              model_hash = excluded.model_hash, built_at = excluded.built_at, updated_at = now()
          WHERE floor_plan.site_model.model_hash IS DISTINCT FROM excluded.model_hash'"

# Read the result back: prod must now hold exactly the local keys and hashes.
ssh "$SSH_HOST" "$PROD_PSQL -At -c \"$LIST_SQL\"" | sort > "$work/prod"
report "after push"
if ! cmp -s "$work/local" "$work/prod"; then
    echo "[$(ts)] Production's site models differ from local after the push." >&2
    exit 1
fi
echo "[$(ts)] Production holds the same $(wc -l < "$work/prod" | tr -d ' ') site models as local."
