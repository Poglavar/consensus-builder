#!/usr/bin/env bash
# Export one CDOF tile's public map inputs and a separate cadastral holdout.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
tile_x="${1:-2971}"
tile_y="${2:-33018}"
env_file="${CADASTRE_ENV_FILE:-$HOME/Code/cadastre-data/.env}"
output="${3:-$root/output/tile_${tile_x}_${tile_y}}"
mkdir -p "$output"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -v tile_x="$tile_x" -v tile_y="$tile_y" \
  -f "$root/input.sql" > "$output/input.json"
psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -v tile_x="$tile_x" -v tile_y="$tile_y" \
  -f "$root/truth.sql" > "$output/truth.json"
echo "Exported tile_${tile_x}_${tile_y}: $output"
