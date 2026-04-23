#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${ATEL_MCP_OPENCLAW_PLUGIN_DIR:-$ROOT_DIR/openclaw-plugin/atel-mcp}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"
EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-$OPENCLAW_HOME/extensions}"
EXT_DIR="$EXTENSIONS_DIR/atel-mcp"

SERVER_BASE_URL="${ATEL_MCP_SERVER_BASE_URL:-https://atelai.org}"
PLATFORM_BASE_URL="${ATEL_PLATFORM_BASE_URL:-https://api.atelai.org}"
IDENTITY_PATH="${ATEL_IDENTITY_PATH:-}"
SDK_DIST_PATH="${ATEL_SDK_DIST_PATH:-}"
NACL_PATH="${ATEL_NACL_PATH:-}"
RESTART_GATEWAY="${OPENCLAW_RESTART_GATEWAY:-1}"

die() {
  echo "error: $*" >&2
  exit 1
}

pick_first_file() {
  for candidate in "$@"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

[ -d "$PLUGIN_DIR" ] || die "plugin dir not found: $PLUGIN_DIR"
[ -f "$PLUGIN_DIR/package.json" ] || die "plugin package missing: $PLUGIN_DIR/package.json"
[ -f "$PLUGIN_DIR/openclaw.plugin.json" ] || die "plugin manifest missing: $PLUGIN_DIR/openclaw.plugin.json"
[ -f "$CONFIG_PATH" ] || die "OpenClaw config not found: $CONFIG_PATH"

if [ -z "$IDENTITY_PATH" ]; then
  IDENTITY_PATH="$(pick_first_file \
    "$PWD/.atel/identity.json" \
    "$HOME/.atel/identity.json" \
    "$OPENCLAW_HOME/workspace/.atel/identity.json" \
    "$OPENCLAW_HOME/workspace/atel-sdk/.atel/identity.json" \
    "/tmp/atel-prod-requester/.atel/identity.json" \
  )" || die "ATEL identity not found. Set ATEL_IDENTITY_PATH=/path/to/.atel/identity.json"
fi

[ -f "$IDENTITY_PATH" ] || die "identityPath not readable: $IDENTITY_PATH"
[ -z "$SDK_DIST_PATH" ] || [ -f "$SDK_DIST_PATH" ] || die "sdkDistPath not readable: $SDK_DIST_PATH"
[ -z "$NACL_PATH" ] || [ -f "$NACL_PATH" ] || die "naclPath not readable: $NACL_PATH"

mkdir -p "$EXTENSIONS_DIR"
backup="$CONFIG_PATH.bak-atel-mcp-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONFIG_PATH" "$backup"

# Copy instead of symlink: OpenClaw 2026.4.x discovery ignores symlinked extension dirs on some installs.
rm -rf "$EXT_DIR"
cp -a "$PLUGIN_DIR" "$EXT_DIR"
(cd "$EXT_DIR" && npm install --omit=dev --no-audit --no-fund)

node - "$CONFIG_PATH" "$PLUGIN_DIR" "$EXT_DIR" "$SERVER_BASE_URL" "$PLATFORM_BASE_URL" "$IDENTITY_PATH" "$SDK_DIST_PATH" "$NACL_PATH" <<'NODE'
const fs = require("fs");
const [configPath, pluginDir, extDir, serverBaseUrl, platformBaseUrl, identityPath, sdkDistPath, naclPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
const allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
if (!allow.includes("atel-mcp")) allow.push("atel-mcp");
config.plugins.allow = allow;
config.plugins.entries = config.plugins.entries && typeof config.plugins.entries === "object" ? config.plugins.entries : {};
config.plugins.installs = config.plugins.installs && typeof config.plugins.installs === "object" ? config.plugins.installs : {};
config.plugins.entries["atel-mcp"] = {
  enabled: true,
  config: {
    serverBaseUrl,
    platformBaseUrl,
    identityPath,
    ...(sdkDistPath ? { sdkDistPath } : {}),
    ...(naclPath ? { naclPath } : {}),
    scopes: [
      "identity.read",
      "contacts.read",
      "messages.read",
      "messages.write",
      "orders.read",
      "orders.write",
      "milestones.read",
      "milestones.write",
      "audit.read"
    ]
  }
};
config.plugins.installs["atel-mcp"] = {
  source: "path",
  spec: pluginDir,
  installPath: extDir,
  version: "0.1.0",
  resolvedName: "@atel/openclaw-plugin-atel-mcp",
  resolvedVersion: "0.1.0",
  resolvedSpec: pluginDir,
  installedAt: new Date().toISOString()
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
NODE

openclaw config validate

if [ "$RESTART_GATEWAY" = "1" ]; then
  if systemctl --user status openclaw-gateway.service >/dev/null 2>&1; then
    systemctl --user restart openclaw-gateway.service
  else
    echo "warn: openclaw-gateway user service not found; restart OpenClaw manually." >&2
  fi
fi

echo "ATEL MCP OpenClaw plugin installed."
echo "config=$CONFIG_PATH"
echo "backup=$backup"
echo "extension=$EXT_DIR"
echo "serverBaseUrl=$SERVER_BASE_URL"
echo "platformBaseUrl=$PLATFORM_BASE_URL"
echo "identityPath=$IDENTITY_PATH"
[ -n "$SDK_DIST_PATH" ] && echo "sdkDistPath=$SDK_DIST_PATH"
[ -n "$NACL_PATH" ] && echo "naclPath=$NACL_PATH"
