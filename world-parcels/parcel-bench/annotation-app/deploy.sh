#!/usr/bin/env bash
# Deploy one committed application subtree; leave the shared checkout and other services untouched.
set -euo pipefail
if [[ "${1:-}" != '--run' || ! "${2:-}" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'Usage: bash deploy.sh --run <pushed release commit>'
    exit 2
fi
ssh "${SSH_HOST:-prod-de}" bash -s -- "$2" <<'REMOTE'
set -euo pipefail
release="$1"
repository="$HOME/code/consensus-builder"
service=/srv/autokatastar
destination="$service/releases/$release"
git -C "$repository" fetch origin autokatastar-review --quiet
git -C "$repository" merge-base --is-ancestor "$release" origin/autokatastar-review
[[ -s "$service/secret.env" && -s "$service/bundles/commute-review-v1/batch.json" ]] || {
    echo 'Install the private access key and immutable imagery bundle first.' >&2; exit 1;
}
nginx -t
mkdir -p "$service/releases" "$service/reviews"
if [[ ! -e "$destination" ]]; then
    temporary="$(mktemp -d "$service/releases/.incoming.XXXXXX")"
    git -C "$repository" archive "$release:world-parcels/parcel-bench/annotation-app" | tar -xf - -C "$temporary"
    printf '%s\n' "$release" > "$temporary/RELEASE"
    mv "$temporary" "$destination"
fi
# PM2 reload preserves a previous executable/cwd even when the ecosystem file changes them.
# Each immutable release has a new cwd; replace this one registration before starting it.
pm2 delete autokatastar-review >/dev/null 2>&1 || true
pm2 start "$destination/ecosystem.config.cjs" --only autokatastar-review --update-env >/dev/null
for attempt in {1..20}; do
    if curl -fsS http://127.0.0.1:8791/autokatastar/pregled/api/health >/dev/null 2>&1; then break; fi
    [[ "$attempt" -lt 20 ]] || { echo 'Annotation service did not become ready.' >&2; exit 1; }
    sleep 1
done
install -m 644 "$destination/nginx.conf" /etc/nginx/snippets/autokatastar-review.conf
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import re
path=Path('/etc/nginx/sites-available/zagreb.lol')
text=path.read_text()
include='    include snippets/autokatastar-review.conf;'
if include not in text:
    matches=list(re.finditer(r'^[ \t]*server_name[ \t]+zagreb\.lol;',text,re.M))
    matches=[m for m in matches if '443' in text[text.rfind('server {',0,m.start()):text.find('\n}',m.end())]]
    if len(matches)!=1: raise RuntimeError('Expected one matching HTTPS server block')
    backup=path.with_name(path.name+'.before-autokatastar-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.write_text(text)
    if path.read_text()!=text: raise RuntimeError('Nginx site changed during deployment')
    index=matches[0].end()
    path.write_text(text[:index]+'\n'+include+text[index:])
PY
nginx -t
systemctl reload nginx
ln -s "$destination" "$service/current.next"
mv -Tf "$service/current.next" "$service/current"
pm2 save >/dev/null
printf 'Autokatastar release %s\n' "$release"
REMOTE
curl --fail --silent --show-error https://zagreb.lol/autokatastar/pregled/api/health
