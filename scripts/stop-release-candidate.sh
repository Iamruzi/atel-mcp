#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.runtime/atel-mcp-rc.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no release candidate pid file"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
fi
rm -f "$PID_FILE"
echo "stopped atel-mcp release candidate"
