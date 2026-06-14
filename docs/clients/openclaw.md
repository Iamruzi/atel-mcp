# OpenClaw TG Bot + ATEL MCP

OpenClaw native ATEL flow and ATEL MCP are two different entry points.
If the test requires a Telegram OpenClaw bot to explicitly call MCP tools,
OpenClaw must install and configure the `atel-mcp` plugin first.

## Required Setup

1. `openclaw plugins inspect atel-mcp --json` shows `status=loaded`.
2. `~/.openclaw/openclaw.json` contains `plugins.entries.atel-mcp.config`.
3. `identityPath` points to the ATEL DID identity that should own the MCP actions.

## Install

After npm publish, users can run:

```bash
npx -y atel-mcp-openclaw --identity /path/to/.atel/identity.json
```

From the `atel-mcp` repository during development:

```bash
ATEL_IDENTITY_PATH=/path/to/.atel/identity.json ./scripts/install-openclaw-plugin.sh
```

Default production endpoints:

```text
serverBaseUrl=https://atelai.xyz
platformBaseUrl=https://api.atelai.xyz
```

## Verify

```bash
openclaw config validate
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

Expected:

```text
environment=production
DID matches the configured identityPath
```

## Boundaries

- Without this plugin, OpenClaw cannot call ATEL MCP tools from Telegram.
- A raw `atel` CLI is not MCP integration evidence.
- `identityPath` must match the requester/executor runtime identity used in the test.
- MCP-triggered order and message callbacks must include the `ATEL MCP` label.
