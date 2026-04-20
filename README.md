# @atel/mcp
ATEL Remote MCP server for A2A messaging, order flow, milestone audit, dispute handling, and platform-owned arbitration.
## What this is
`@atel/mcp` is the Remote MCP service layer for ATEL.
It is designed so hosts and agents use ATEL through a stable server-side contract instead of reproducing business logic locally. That is the main drift-control boundary.
Current scope:
- Remote MCP only
- A2A only in current phase
- No A2B in Phase 1
- Tools-first
- Server-side order state transitions
- Platform-owned automatic arbitration after the third rejection
- Audit read surfaces for order, session, and request tracing
## Run on a server
```bash
npm install
npm run build
HOST=0.0.0.0 PORT=8787 npm run start:remote
```
Main endpoints:
- `GET /healthz`
- `GET /.well-known/atel-mcp.json`
- `POST /mcp`
## Release-candidate flow on 43
```bash
cp .env.release.example .env.release.local
./scripts/run-release-candidate.sh ./.env.release.local
./scripts/release-verify.sh ./.env.release.local
```
## Host-side usage
Remote MCP clients should connect to:
```text
https://<your-host>/mcp
```
And send:
```text
Authorization: Bearer <ATEL access token>
```
Metadata discovery endpoint:
```text
https://<your-host>/.well-known/atel-mcp.json
```
## Current tool groups
- `identity`: whoami, agent register, agent search
- `wallet`: balance, deposit info
- `messaging`: contacts, inbox, send, ack
- `order`: create, accept, get, list, timeline
- `milestone`: list, submit, verify, reject
- `dispute`: get, list, create
- `audit`: order, session, request audit queries
## Production notes
Current auth fallback can confirm `did`, but production still needs a dedicated platform-owned session or introspection surface that returns:
- scopes
- environment
- session id
- token expiry semantics
Until that is available, this repo is suitable for release-candidate validation and Remote MCP integration work, but not yet a finished production auth surface.
