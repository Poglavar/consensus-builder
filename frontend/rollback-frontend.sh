#!/bin/bash
# Restores the frontend docroot from the single backup deploy-frontend.sh keeps (the deployment that
# was live before the latest deploy). --dry-run prints what it would restore; only --apply changes it.

set -euo pipefail

SSH_HOST="${SSH_HOST:-prod-de}"
DOCROOT='/var/www/urbangametheory.xyz'      # must match deploy-frontend.sh
SITE_URL="${SITE_URL:-https://urbangametheory.xyz}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    echo "Usage: $0 --dry-run | --apply"
    echo "  --dry-run: show the live release and the backup that would replace it; change nothing."
    echo "  --apply:   show the same, then restore that backup into $DOCROOT on \$SSH_HOST ($SSH_HOST),"
    echo "             purge Cloudflare and check the public release.json."
}
case "${1:-}" in
    --dry-run) APPLY=0 ;;
    --apply) APPLY=1 ;;
    ''|-h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
esac

# Optional .env for CF_ZONE_ID / CF_API_KEY (Cloudflare cache purge), same file the deploy reads.
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Remote block: find the one backup, report both releases, and restore only when APPLY=1. The
# restore mirrors the deploy's two passes (non-HTML first, HTML last) and keeps the current
# laptop-generated carto-config.js / rpc-config.js, which are runtime config, not release content.
REMOTE_OUT=$(mktemp "${TMPDIR:-/tmp}/cb-rollback.XXXXXX")
trap 'rm -f "$REMOTE_OUT"' EXIT
ssh -o StrictHostKeyChecking=accept-new "$SSH_HOST" "DOCROOT='$DOCROOT' APPLY='$APPLY' bash -s" <<'REMOTE' | tee "$REMOTE_OUT"
set -euo pipefail
release_of() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('commit','?'), d.get('buildId','?'), d.get('generatedAt','?'))" "$1/release.json" 2>/dev/null || echo "(no readable release.json)"; }

BACKUPS=$(ls -d "${DOCROOT}"_backup_* 2>/dev/null | grep -E "^${DOCROOT}_backup_[0-9]{8}_[0-9]{6}$" | sort || true)
COUNT=$(printf '%s' "$BACKUPS" | grep -c . || true)
if [ "$COUNT" -eq 0 ]; then echo "❌ No backup ${DOCROOT}_backup_* found — nothing to restore." >&2; exit 1; fi
BACKUP=$(printf '%s\n' "$BACKUPS" | tail -n 1)
[ "$COUNT" -eq 1 ] || echo "⚠️  $COUNT backups found; using the newest."
[ -f "$BACKUP/index.html" ] || { echo "❌ $BACKUP has no index.html — refusing to restore it." >&2; exit 1; }

echo "Live:    $DOCROOT  -> $(release_of "$DOCROOT")"
echo "Restore: $BACKUP  -> $(release_of "$BACKUP")"
if [ "$APPLY" != 1 ]; then echo "Dry run: nothing changed. Re-run with --apply to restore."; exit 0; fi
echo "Restoring $BACKUP into $DOCROOT..."

EXCLUDES=(--exclude='/carto-config.js' --exclude='/rpc-config.js')
rsync -a --exclude='*.html' "${EXCLUDES[@]}" "$BACKUP/" "$DOCROOT/"
rsync -a --delete "${EXCLUDES[@]}" "$BACKUP/" "$DOCROOT/"
chown -R www-data:www-data "$DOCROOT"; chmod -R 755 "$DOCROOT"
echo "RESTORED $(release_of "$DOCROOT")"
echo "RESTORED_COMMIT=$(python3 -c "import json; print(json.load(open('$DOCROOT/release.json')).get('commit',''))" 2>/dev/null || true)"
REMOTE

[ "$APPLY" = 1 ] || exit 0
EXPECTED=$(sed -n 's/^RESTORED_COMMIT=//p' "$REMOTE_OUT")

echo "☁️  Purging Cloudflare cache..."
if [[ -z "${CF_ZONE_ID:-}" || -z "${CF_API_KEY:-}" ]]; then
    echo "❌ CF_ZONE_ID / CF_API_KEY not set in frontend/.env — docroot restored, edge cache NOT purged; rollback NOT complete." >&2
    exit 1
fi
cf_result=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_API_KEY}" -H "Content-Type: application/json" \
    --data '{"purge_everything":true}' || true)
if ! echo "$cf_result" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    echo "❌ Cloudflare purge failed: $cf_result — docroot restored, rollback NOT complete." >&2
    exit 1
fi
echo "✅ Cloudflare cache purged"
LIVE=$(curl -fsS --max-time 20 "${SITE_URL}/release.json?verify=rollback-$(date +%s)" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit') or '')" 2>/dev/null || true)
if [[ -z "$EXPECTED" || "$LIVE" != "$EXPECTED" ]]; then
    echo "❌ Public release.json reports '${LIVE:-<unreadable>}', restored backup has '${EXPECTED:-<unknown>}' — rollback NOT verified." >&2
    exit 1
fi
echo "✅ Rollback complete: public release.json reports ${LIVE:0:9}."
