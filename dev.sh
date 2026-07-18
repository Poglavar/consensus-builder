#!/usr/bin/env bash
# Per-worktree dev launcher: starts this worktree's backend (on a custom port) and the frontend
# (static `serve`), points the frontend at the backend via ?backend=, and prints the URL.
# Goal: test any branch/worktree with one command and zero manual port config.
#
#   ./dev.sh                       # auto-pick stable, collision-free ports for this worktree
#   BACKEND_PORT=4001 ./dev.sh     # pin the backend port
#   FRONTEND_PORT=5001 ./dev.sh    # pin the frontend port
#
# Each worktree derives its own default ports from its folder name, so several worktrees can run
# at once. The frontend's ?backend= override (frontend/js/data-source.js) is localhost-only, so it
# never affects production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")"
NAME="$(basename "$ROOT")"

# Stable-ish per-worktree seed (so a worktree tends to reuse the same ports across runs),
# then bump to the next free port to avoid clashes when multiple worktrees run together.
seed=$(( $(cksum <<<"$NAME" | cut -d' ' -f1) % 1000 ))
find_free_port() {
  local p=$1
  while lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p + 1)); done
  echo "$p"
}
BACKEND_PORT="${BACKEND_PORT:-$(find_free_port $((4000 + seed)))}"
FRONTEND_PORT="${FRONTEND_PORT:-$(find_free_port $((5000 + seed)))}"

BACKEND_URL="http://localhost:${BACKEND_PORT}"
FRONTEND_URL="http://localhost:${FRONTEND_PORT}/?backend=${BACKEND_URL}"

if [ ! -d "$ROOT/backend/node_modules" ]; then
  echo "[dev] WARNING: $ROOT/backend/node_modules missing — run 'cd backend && npm install' first." >&2
fi
if [ ! -f "$ROOT/backend/.env" ]; then
  echo "[dev] WARNING: $ROOT/backend/.env missing — backend may fail to reach the database." >&2
fi

echo "[dev] worktree:  $ROOT"
echo "[dev] backend:   $BACKEND_URL  (API_PORT=$BACKEND_PORT)"
echo "[dev] frontend:  $FRONTEND_URL"
echo ""

pids=()
cleanup() {
  echo ""
  echo "[dev] shutting down..."
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# Backend: run with cwd=backend so dotenv loads THIS worktree's backend/.env; API_PORT sets the
# port. A shell env var wins over .env (dotenv does not override), so we also remap the DB host:
# the committed .env uses PGHOST=db (the docker-compose service name, resolvable only inside the
# docker network). Run natively, the docker postgres is reachable on the host at localhost:5432,
# so default PGHOST=localhost here. Override by exporting PGHOST=... before running.
( cd "$ROOT/backend" && API_PORT="$BACKEND_PORT" PGHOST="${PGHOST:-localhost}" npm start ) &
pids+=("$!")

# Frontend: static server of the frontend dir. -s rewrites unknown paths to
# index.html so /proposals/... links work (parity with the prod nginx config).
( serve -s "$ROOT/frontend" -l "$FRONTEND_PORT" ) &
pids+=("$!")

echo "[dev] ready → open: $FRONTEND_URL"
wait
