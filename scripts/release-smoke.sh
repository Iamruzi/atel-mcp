#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.release.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"

run_case() {
  local label="$1"
  shift

  echo "==> release smoke case: $label"
  ./scripts/stop-release-candidate.sh || true
  npm run smoke:cleanup
  ./scripts/run-release-candidate.sh "$ENV_FILE"
  sleep 2
  ./scripts/healthcheck.sh "$ENV_FILE"

  set -a
  source "$ENV_FILE"
  set +a

  "$@"
}

run_case "happy-path" node dist/dev/smoke-happy-path.js
run_case "dispute" node dist/dev/smoke-dispute.js
run_case "auto-arbitration-passed" env ATEL_MCP_ARBITRATION_EXPECTED=passed node dist/dev/smoke-auto-arbitration.js
run_case "auto-arbitration-failed" env ATEL_MCP_ARBITRATION_EXPECTED=failed node dist/dev/smoke-auto-arbitration.js
