#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_SRC="$ROOT_DIR/ops/env/atel-mcp.production.env.example"
SYSTEMD_SRC="$ROOT_DIR/ops/systemd/atel-mcp.service"
NGINX_SRC="$ROOT_DIR/ops/nginx/atelai-mcp.locations.conf"

ENV_DST="/etc/atel/atel-mcp.env"
SYSTEMD_DST="/etc/systemd/system/atel-mcp.service"
NGINX_DIR="/etc/nginx/conf.d/atelai-extra"
NGINX_DST="$NGINX_DIR/atel-mcp.locations.conf"
NGINX_MAIN="/etc/nginx/conf.d/atelai.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

for required in "$ENV_SRC" "$SYSTEMD_SRC" "$NGINX_SRC" "$NGINX_MAIN"; do
  if [[ ! -f "$required" ]]; then
    echo "Missing required file: $required" >&2
    exit 1
  fi
done

mkdir -p /etc/atel /opt/atel-mcp/.runtime/audit "$NGINX_DIR"

if [[ ! -f "$ENV_DST" ]]; then
  install -D -m 640 "$ENV_SRC" "$ENV_DST"
  echo "[installed] $ENV_DST"
else
  echo "[kept] $ENV_DST"
fi

install -D -m 644 "$SYSTEMD_SRC" "$SYSTEMD_DST"
echo "[installed] $SYSTEMD_DST"

install -D -m 644 "$NGINX_SRC" "$NGINX_DST"
echo "[installed] $NGINX_DST"

python3 - <<'PY' "$NGINX_MAIN"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
include_line = "    include /etc/nginx/conf.d/atelai-extra/*.conf;"
if include_line in text:
    print(f"[kept] {path} already includes atelai-extra")
    raise SystemExit(0)

anchor = "    # Dashboard root static assets"
if anchor not in text:
    raise SystemExit(f"anchor not found in {path}: {anchor}")

text = text.replace(anchor, include_line + "\n\n" + anchor, 1)
path.write_text(text)
print(f"[patched] {path}")
PY

systemctl daemon-reload
systemctl enable atel-mcp.service >/dev/null
systemctl restart atel-mcp.service
nginx -t
systemctl reload nginx

echo "[service] $(systemctl is-active atel-mcp.service)"
curl -fsS http://127.0.0.1:8787/healthz
