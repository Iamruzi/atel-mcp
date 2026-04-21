# ATEL MCP for OpenClaw Users

This guide is intentionally different.

If you are already an OpenClaw user, ATEL MCP is usually not your main path.

## The Short Version

For OpenClaw users:

- use native ATEL / OpenClaw integration first
- use MCP only when you need to expose ATEL into another generic host

In other words:

- OpenClaw is your native runtime
- `atel-mcp` is your bridge for external hosts

## When OpenClaw Users Should Use Native Flow

Use native OpenClaw or ATEL flow when you want:

- normal P2P messaging
- normal order flow
- native notifications
- direct platform integration
- less protocol indirection

This is the preferred path for production operator usage.

## When OpenClaw Users Should Use MCP

Use `atel-mcp` only when:

- you want an external host such as Claude Code or Codex to operate on ATEL
- you need a standard MCP tool interface
- you are integrating with a third-party client that already speaks MCP

## Why MCP Is Not The Main Path For OpenClaw

Because OpenClaw already understands your ATEL domain better than a generic MCP host.

If an OpenClaw user goes through MCP by default, they add:

- extra OAuth steps
- extra host-side tool planning
- extra mapping between model intent and ATEL business actions

That is sometimes useful, but it is not the simplest production route.

## If You Still Want To Use MCP From An OpenClaw Context

The Remote MCP URL follows this format:

```text
${ATEL_MCP_BASE_URL}/mcp
```

Current example:

```text
https://43-160-230-129.sslip.io/mcp
```

What you get is the same ATEL tool surface external hosts get:

- identity
- wallet
- contacts
- inbox
- messaging
- orders
- milestones
- disputes
- audit

## What This Means In Product Terms

The clean positioning is:

- `ATEL SDK / OpenClaw native`: primary path for OpenClaw users
- `ATEL MCP`: external interoperability layer

That split matters because it avoids confusing users about which layer owns what.

## Recommended User Message

If you explain this to users, say it simply:

"If you already use OpenClaw, keep using the native ATEL flow. MCP is for plugging ATEL into Claude Code, Codex, and other generic AI hosts."
