#!/usr/bin/env bash
# sync.sh: move the parcel-bench code and the exported dataset to a rented GPU box, and bring run results back.
# Only what training needs goes up (code, images, truth, OSM inputs, manifests); the spike's 13 GB of SAM caches
# and masks never leave the laptop. Results come back without weights unless --with-weights.
#   sync.sh push <ssh-url> [dataset-dir]        sync.sh pull <ssh-url> <run-name> [--with-weights]
# <ssh-url> is what `vastai ssh-url <instance>` prints, e.g. ssh://root@1.2.3.4:12345
# Works with macOS's old rsync 2.6.9 (no --info=progress2).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"                       # world-parcels/parcel-bench
SPIKE="$(cd "$BENCH/../guess-spike" && pwd)"          # world-parcels/guess-spike (python only)
ROOT_REMOTE="${PARCEL_ROOT:-/root/parcel-bench}"
cmd="${1:-}"; url="${2:-}"
[ -n "$cmd" ] && [ -n "$url" ] || { sed -n '2,7p' "$0"; exit 2; }
target="${url#ssh://}"; port="${target##*:}"; target="${target%%:*}"   # user@host
SSH_CMD="ssh -p $port -o StrictHostKeyChecking=accept-new"
rs() { rsync -az --stats -e "$SSH_CMD" "$@" | grep -E 'Number of (regular )?files transferred|Total transferred file size' | tr '\n' ' '; echo; }
case "$cmd" in
  push)
    dataset="${3:-$SPIKE/output/parcel-expanded-check/dataset}"
    $SSH_CMD "$target" "mkdir -p $ROOT_REMOTE/world-parcels/parcel-bench $ROOT_REMOTE/world-parcels/guess-spike $ROOT_REMOTE/data/dataset"
    echo -n "code:    "; rs --exclude 'output/' --exclude '__pycache__/' --exclude 'results.jsonl' "$BENCH/" "$target:$ROOT_REMOTE/world-parcels/parcel-bench/"
    echo -n "spike:   "; rs --include '*.py' --exclude '*' "$SPIKE/" "$target:$ROOT_REMOTE/world-parcels/guess-spike/"
    echo -n "dataset: "; rs --include '*/' --include 'manifest.json' --include 'osm-inputs-*.json' --include '*.jpg' \
      --include '*.truth.json' --include '*.input.json' --include '*.osm-input.json' --exclude '*' \
      "$dataset/" "$target:$ROOT_REMOTE/data/dataset/"
    echo "pushed; on the box: bash $ROOT_REMOTE/world-parcels/parcel-bench/gpu/bootstrap.sh" ;;
  pull)
    run="${3:-}"; [ -n "$run" ] || { echo "usage: sync.sh pull <ssh-url> <run-name> [--with-weights]" >&2; exit 2; }
    mkdir -p "$BENCH/output/runs/$run"
    if [ "${4:-}" = "--with-weights" ]; then rs "$target:$ROOT_REMOTE/runs/$run/" "$BENCH/output/runs/$run/"
    else rs --exclude '*.pt' "$target:$ROOT_REMOTE/runs/$run/" "$BENCH/output/runs/$run/"; fi
    echo "pulled to $BENCH/output/runs/$run" ;;
  *) sed -n '2,7p' "$0"; exit 2 ;;
esac
