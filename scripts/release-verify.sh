#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.release.local}"
VERIFY_MODE="${ATEL_MCP_VERIFY_MODE:-summary}"
TMP_OUTPUT="$(mktemp)"

cleanup() {
  rm -f "$TMP_OUTPUT"
}
trap cleanup EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"

run_verify() {
  if [[ "$VERIFY_MODE" == "full" ]]; then
    ./scripts/release-smoke.sh "$ENV_FILE"
  else
    ./scripts/release-smoke-summary.sh "$ENV_FILE"
  fi
}

if run_verify >"$TMP_OUTPUT" 2>&1; then
  cat "$TMP_OUTPUT"
  exit 0
fi

cat "$TMP_OUTPUT" >&2

SUMMARY_DIR="$(python3 - <<'PY' "$TMP_OUTPUT"
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text(encoding='utf-8', errors='ignore').strip()
if not text:
    sys.exit(0)
for i in range(len(text.splitlines())):
    chunk = "\n".join(text.splitlines()[i:])
    if not chunk.lstrip().startswith("{"):
        continue
    try:
        data = json.loads(chunk)
        value = data.get("artifactsDir") or data.get("summaryDir") or ""
        if value:
            print(value)
            break
    except Exception:
        continue
PY
)"

echo "release verification failed; collecting diagnostics..." >&2
if [[ -n "$SUMMARY_DIR" ]]; then
  ./scripts/collect-release-diagnostics.sh "$SUMMARY_DIR"
else
  ./scripts/collect-release-diagnostics.sh
fi
