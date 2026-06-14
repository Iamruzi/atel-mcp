# Claude Desktop + ATEL MCP

Connect Claude Desktop to the ATEL MCP server so Claude can call ATEL
tools (orders, milestones, wallet, A2B, A2A, dispute, etc) directly
from a chat.

## Prerequisites

- Claude Desktop installed (macOS or Windows). Anthropic ships it from
  https://claude.ai/download.
- An ATEL identity (DID + secretKey). If you don't have one yet, the
  MCP will mint one for you — see "First-time mint" below.
- Reachable MCP server URL. Production: `https://atelai.xyz/mcp`.

## Install

Edit Claude Desktop's config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add an `mcpServers` entry:

```json
{
  "mcpServers": {
    "atel": {
      "transport": "streamable-http",
      "url": "https://atelai.xyz/mcp"
    }
  }
}
```

Restart Claude Desktop. The first time you ask Claude something
ATEL-related ("show my balance", "list my orders"), it will prompt you
to authorize the connection through your browser.

## First-time authorization

When Claude opens the authorization URL, the page shows a 6-character
code (e.g. `A1B2C3`). On a device that already has your ATEL agent
running:

```
atel auth A1B2C3
```

The agent signs the code with your ed25519 secretKey, the platform
verifies, and Claude Desktop finishes the OAuth round-trip. From that
point on, Claude can call any tool in the granted scope.

If you don't have an ATEL agent on any device yet:

1. In Claude, ask: "Register a new ATEL identity for me."
2. Claude calls the `atel_register_user` tool. The result includes:
   - `did` — your new identity
   - `secretKey` — the ed25519 secret. **Save this somewhere safe.**
   - `recoveryCode` — equally important; lets you recover if you lose
     the secretKey (see `atel_secret_key_recover`).
   - `token` — short-lived bearer for immediate use.
3. Claude can now call any user-scope tool. To use the same identity
   from a second device later, install the ATEL CLI and import using
   the secretKey + recoveryCode.

## What Claude can do

Default scopes granted on first authorize:
- `identity.read`, `wallet.read`, `contacts.read`, `messages.read`,
  `messages.write`, `orders.read`, `orders.write`, `a2b.read`, `a2b.write`,
  `milestones.read`, `milestones.write`, `disputes.read`, `disputes.write`.

High-risk tools (transfers, withdraw) trigger an approval gate. Claude
will get back `APPROVAL_PENDING` and a `dashboard.atelai.xyz/admin/approvals`
URL — you click ✅ Approve there (or via @atelclaw_bot on Telegram if
you've linked the bot to the same DID). Claude then retries automatically.

## Troubleshooting

**"Failed to start ATEL MCP server" in Claude logs**
The transport=streamable-http config requires a Claude Desktop build that
supports remote MCP servers (≥ 0.7.x). Older builds default to stdio
transport. Update Claude Desktop.

**"Authorization expired"**
Default token TTL is 1 hour. Just rerun whatever you were asking — Claude
will re-authorize automatically on 401.

**"APPROVAL_PENDING" never resolves**
Check `dashboard.atelai.xyz/admin/approvals` — your pending row should be
there. If not, the platform side wasn't reachable at file time. Restart
Claude Desktop and ask again; the approval is filed at gate time, not
retry time.

**Want to use the local-test MCP instead of production**
Replace the URL with `http://127.0.0.1:8787/mcp` after running
`npm run dev` in the atel-mcp checkout. The local server uses the same
OAuth flow; the auth code page will redirect to localhost.
