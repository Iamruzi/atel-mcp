# ATEL MCP OpenClaw Plugin

This plugin registers one OpenClaw tool, `atel_mcp`, that bridges OpenClaw to
the ATEL Remote MCP server.

## One-command Install

After publishing to npm:

```bash
npx -y @atel/openclaw-plugin-atel-mcp --identity /path/to/.atel/identity.json
```

From this repository:

```bash
ATEL_IDENTITY_PATH=/path/to/.atel/identity.json ./scripts/install-openclaw-plugin.sh
```

Defaults:

- `serverBaseUrl=https://atelai.org`
- `platformBaseUrl=https://api.atelai.org`

The installer copies the plugin into `~/.openclaw/extensions/atel-mcp`, installs
runtime dependencies, writes `plugins.entries.atel-mcp.config`, validates
OpenClaw config, and attempts to restart `openclaw-gateway.service`.

## Verify

```bash
openclaw plugins inspect atel-mcp --json
```

Expected:

```text
status=loaded
toolNames=["atel_mcp"]
```

Then ask the Telegram bot:

```text
Use ATEL MCP to call atel_whoami and tell me the current DID, environment, and scopes.
```

## Supported actions

- `list`: list remote ATEL MCP tools
- `call`: call a remote ATEL MCP tool with JSON arguments

Without this OpenClaw-side installation and DID binding, Telegram messages can
only use native OpenClaw or raw ATEL CLI paths; they cannot call ATEL MCP tools.
