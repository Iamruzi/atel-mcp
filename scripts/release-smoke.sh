#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.release.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"
./scripts/stop-release-candidate.sh || true
npm run smoke:cleanup
./scripts/run-release-candidate.sh "$ENV_FILE"
sleep 2
./scripts/healthcheck.sh "$ENV_FILE"

set -a
source "$ENV_FILE"
set +a

node dist/dev/smoke-happy-path.js
