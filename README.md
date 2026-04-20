# atel-mcp

ATEL Remote MCP server workspace.

Current scope:
- Remote MCP only
- No A2B in Phase 1
- Tools-first
- Reuse ATEL platform + SDK domain logic instead of wrapping CLI
- Drift-control first: keep business state transitions server-side
- Audit read surfaces for order, session, and request tracing
- Platform-owned automatic arbitration after the third rejection; hosts do not decide arbitration policy

Initial outputs in this scaffold:
- architecture and scope docs
- tool/scope/error contracts
- work-package split for engineering
- MCP server runtime over HTTP transport
- first real MCP client smoke for `listTools` plus full happy-path and arbitration flows

Not done yet:
- production OAuth / deployment wiring
- release docs

## Current working status

- `npm run typecheck`: passing
- `npm run build`: passing
- `npm test`: passing
- `npm run smoke:http`: passing
- `npm run smoke:cleanup`: passing
- `npm run smoke:happy`: passing
- `npm run smoke:auto-arbitration`: passing for both `arbitration_passed` and `arbitration_failed`
- `npm run smoke:env-mismatch`: passing

## Current auth gap

The MCP server currently tries:
- `GET /auth/v1/session`
- then falls back to `GET /auth/v1/me`

Today, fallback to `/auth/v1/me` is enough to confirm `did`, but it does **not** provide:
- scopes
- environment
- session id
- token expiry semantics

For production Remote MCP, platform must expose a dedicated session/introspection surface such as:
- `GET /auth/v1/session`
- or `POST /auth/v1/introspect`

The Remote MCP server should then derive:
- `did`
- `environment`
- `scopes`
- `sessionId`
- `expiresAt`

from that server-owned source, not from host-provided headers.
