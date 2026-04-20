#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.release.local}"
PID_FILE="$ROOT_DIR/.runtime/atel-mcp-rc.pid"
LOG_FILE="$ROOT_DIR/.runtime/atel-mcp-rc.log"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/.runtime"
set -a
source "$ENV_FILE"
set +a

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "atel-mcp release candidate already running: PID $(cat "$PID_FILE")"
  exit 0
fi

cd "$ROOT_DIR"
npm run build >/dev/null
nohup node dist/server/http.js >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "started atel-mcp release candidate pid=$(cat "$PID_FILE") log=$LOG_FILE"
