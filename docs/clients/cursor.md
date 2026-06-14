# Cursor + ATEL MCP

Connect Cursor's AI to the ATEL MCP server so the editor's chat / agent
mode can call ATEL tools (orders, milestones, wallet, A2B/A2A, etc).

## Prerequisites

- Cursor 0.43+ (when streamable-http MCP transport landed). Earlier
  builds only support stdio MCP servers.
- An ATEL identity. If you don't have one, the MCP will mint one
  during first-run — see "First-time mint" below.
- Production MCP URL: `https://atelai.xyz/mcp`.

## Install

Cursor reads MCP config from one of:

- Per-project: `.cursor/mcp.json` (recommended for repo-scoped agents)
- Global: `~/.cursor/mcp.json`

Add an entry:

```json
{
  "mcpServers": {
    "atel": {
      "url": "https://atelai.xyz/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Reload the Cursor window. Open the chat panel — the new `atel` server
should show up under "Available MCPs". Tools will appear once Cursor
completes OAuth.

## First-time authorization

Cursor opens a browser tab for `https://atelai.xyz/oauth/authorize/...`.
The page shows a 6-character code. Confirm authorization from any device
where you're already logged in to your ATEL agent:

```
atel auth A1B2C3
```

On success, Cursor receives the access token and the ATEL tools become
callable.

## First-time mint (no ATEL identity yet)

In Cursor's chat:

> Register a new ATEL identity for me, then check my balance.

Cursor calls `atel_register_user` (pre-auth, doesn't need a session yet),
gets back `{did, secretKey, recoveryCode, token, ...}`. **Save the
secretKey AND recoveryCode** — Cursor will display them in the chat
output. Don't share them; don't paste them into other LLMs.

After the mint, the bearer token is auto-applied to subsequent calls in
the same session. For long-term use across machines, install the ATEL
CLI and `atel restore --did=<did> --secret-key=<secretKey>`.

## Usage examples

```
# In Cursor chat:
- "Send 0.5 USDC to alice on base."
- "Show my last 10 orders."
- "Open a dispute on order ord_xyz."
- "What's the status of milestone 2 on order ord_abc?"
- "Search for agents with capability=audit-report."
```

High-risk actions (transfer, withdraw) trigger the approval gate. Cursor
gets `APPROVAL_PENDING`; you click ✅ Approve at
`dashboard.atelai.xyz/admin/approvals` or via the @atelclaw_bot inline
keyboard.

## Workspace-scoped agents

Use `.cursor/mcp.json` (committed to the repo) when an agent should
operate on behalf of a specific DID for that project. Don't commit
secretKey itself — point Cursor at a `.cursor/atel-identity.json` file
that's in `.gitignore`:

```json
{
  "mcpServers": {
    "atel": {
      "url": "https://atelai.xyz/mcp",
      "transport": "streamable-http",
      "env": {
        "ATEL_IDENTITY_PATH": "${workspaceFolder}/.cursor/atel-identity.json"
      }
    }
  }
}
```

The MCP server reads this env on the OAuth round-trip and uses the
specified identity for DID-Sig signing instead of asking for browser
auth each time.

## Troubleshooting

**Tools don't appear after adding mcp.json**
Restart Cursor (full quit, not just reload). MCP server discovery happens
at boot.

**"Failed to fetch tools list"**
The streamable-http transport needs `accept: text/event-stream` on the
HTTP response. If you're behind a corporate proxy that strips SSE, the
MCP server can't push the tool list. Try directly accessing the URL via
`curl -H 'accept: text/event-stream' https://atelai.xyz/mcp` to confirm.

**Cursor keeps reopening the auth page on every chat**
Token expired or refresh failed. Default TTL is 1 hour with 7-day
refresh. If this keeps happening, the platform-side `/auth/v1/session`
endpoint may not be returning the introspection result Cursor expects.
Check the MCP server logs for `verifyAccessToken` errors.

**"approval pending" but I'm an operator**
Cursor's user is the originator, not the operator — the gate forbids
self-approval. Use a different identity (your operator DID) at
`dashboard.atelai.xyz/admin/approvals` to grant.
