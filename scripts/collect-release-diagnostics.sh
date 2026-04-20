#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
AUDIT_FILE="$RUNTIME_DIR/audit/atel-mcp-rc.jsonl"
RC_LOG_FILE="$RUNTIME_DIR/atel-mcp-rc.log"
RC_PID_FILE="$RUNTIME_DIR/atel-mcp-rc.pid"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${2:-$RUNTIME_DIR/diagnostics/$TIMESTAMP}"
SUMMARY_DIR_INPUT="${1:-}"

mkdir -p "$OUT_DIR"

resolve_summary_dir() {
  if [[ -n "$SUMMARY_DIR_INPUT" ]]; then
    if [[ -d "$SUMMARY_DIR_INPUT" ]]; then
      cd "$SUMMARY_DIR_INPUT" >/dev/null 2>&1 && pwd
      return 0
    fi
    echo "Provided summary dir does not exist: $SUMMARY_DIR_INPUT" >&2
    return 1
  fi

  local latest
  latest="$(find "$RUNTIME_DIR" -maxdepth 1 -type d -name 'release-summary-*' | sort | tail -n 1 || true)"
  if [[ -n "$latest" && -d "$latest" ]]; then
    cd "$latest" >/dev/null 2>&1 && pwd
    return 0
  fi
  return 1
}

SUMMARY_DIR=""
if SUMMARY_DIR="$(resolve_summary_dir)"; then
  mkdir -p "$OUT_DIR/release-summary"
  cp -R "$SUMMARY_DIR"/. "$OUT_DIR/release-summary/"
fi

if [[ -f "$RC_LOG_FILE" ]]; then
  cp "$RC_LOG_FILE" "$OUT_DIR/atel-mcp-rc.log"
  tail -n 200 "$RC_LOG_FILE" > "$OUT_DIR/atel-mcp-rc.tail.log"
fi

if [[ -f "$AUDIT_FILE" ]]; then
  cp "$AUDIT_FILE" "$OUT_DIR/atel-mcp-rc.audit.jsonl"
  tail -n 200 "$AUDIT_FILE" > "$OUT_DIR/atel-mcp-rc.audit.tail.jsonl"
fi

if [[ -f "$RC_PID_FILE" ]]; then
  cp "$RC_PID_FILE" "$OUT_DIR/atel-mcp-rc.pid"
fi

{
  echo "timestamp=$TIMESTAMP"
  echo "root_dir=$ROOT_DIR"
  echo "out_dir=$OUT_DIR"
  echo "summary_dir=${SUMMARY_DIR:-}"
  echo "git_head=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
  echo "git_status_start"
  git -C "$ROOT_DIR" status --short 2>/dev/null || true
  echo "git_status_end"
  echo "process_check_start"
  if [[ -f "$RC_PID_FILE" ]]; then
    PID="$(cat "$RC_PID_FILE" 2>/dev/null || true)"
    echo "pid=$PID"
    ps -p "$PID" -o pid=,ppid=,etime=,args= 2>/dev/null || true
  fi
  echo "process_check_end"
} > "$OUT_DIR/meta.txt"

if command -v tar >/dev/null 2>&1; then
  TAR_PATH="$OUT_DIR.tar.gz"
  tar -czf "$TAR_PATH" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"
fi

printf '{\n'
printf '  "ok": true,\n'
printf '  "outDir": "%s",\n' "$OUT_DIR"
printf '  "summaryDir": "%s",\n' "${SUMMARY_DIR:-}"
printf '  "tarball": "%s"\n' "${TAR_PATH:-}"
printf '}\n'
