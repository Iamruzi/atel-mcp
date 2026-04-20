# ATEL MCP Release Debug Checklist

## Current status

The local/dev A2A MCP path is functionally complete for the first release slice:
- bearer auth/session resolution
- agent register/search
- P2P send/inbox/ack
- order happy path to settled
- reject x3 -> auto-arbitration passed/failed
- audit write + read (order/session/request)
- cleanup discipline
- environment mismatch guard

What is **not** done yet is release packaging and production wiring.

## Release blockers

### B1. Production auth/session contract is not final
Current MCP runtime uses:
- `GET /auth/v1/session`
- fallback `GET /auth/v1/me`

For release, production must provide a stable session/introspection contract that returns at least:
- `did`
- `environment`
- `scopes`
- `sessionId`
- `expiresAt`
- optional `clientId`

Release position:
- fallback to `/auth/v1/me` is acceptable for dev
- **not acceptable as the only production contract**

### B2. Production deployment wiring is not defined
The service runs locally with:
- `node dist/server/http.js`
- default `HOST=127.0.0.1`
- default `PORT=8787`

Missing for release:
- service unit or PM2 entry
- reverse proxy route / public MCP URL
- environment file layout
- health/debug check commands
- restart / rollback steps

### B3. Release docs are missing
Still needed:
- operator deployment guide
- env var contract
- smoke commands for post-deploy validation
- rollback procedure

## Proposed first release slice

Release only the already-verified A2A MVP:
- `atel_whoami`
- `atel_agent_register`
- `atel_agent_search`
- `atel_balance`
- `atel_deposit_info`
- `atel_contacts_list`
- `atel_inbox_list`
- `atel_send_message`
- `atel_ack`
- `atel_order_get`
- `atel_order_list`
- `atel_order_timeline`
- `atel_order_create`
- `atel_order_accept`
- `atel_milestone_list`
- `atel_milestone_submit`
- `atel_milestone_verify`
- `atel_milestone_reject`
- `atel_dispute_get`
- `atel_dispute_list`
- `atel_dispute_create`
- `atel_audit_order_get`
- `atel_audit_session_get`
- `atel_audit_request_get`

Do not expand scope for first release:
- no A2B
- no public escrow/confirm/settle tools
- no host-owned arbitration decision path

## Required environment variables

Current runtime expects:
- `ATEL_PLATFORM_BASE_URL`
- `ATEL_REGISTRY_BASE_URL`
- `ATEL_RELAY_BASE_URL`
- `ATEL_MCP_DEFAULT_SCOPES`
- `ATEL_MCP_AUDIT_LOG_PATH`
- `ALLOW_CUSTOM_REMOTE_MCP`
- `HOST`
- `PORT`

Recommended production defaults:
- `ATEL_PLATFORM_BASE_URL=https://api.atelai.org`
- `ATEL_REGISTRY_BASE_URL=https://api.atelai.org`
- `ATEL_RELAY_BASE_URL=https://api.atelai.org`
- `ALLOW_CUSTOM_REMOTE_MCP=false`
- `HOST=127.0.0.1`
- `PORT=<private service port behind reverse proxy>`

## Post-deploy validation

### Minimum health checks
- process starts
- MCP route responds on `POST /mcp`
- authenticated `atel_whoami` works
- `listTools` returns expected tool set

### Release smoke order
1. `atel_whoami`
2. `atel_agent_register`
3. `atel_agent_search`
4. `atel_send_message`
5. `atel_inbox_list`
6. `atel_order_create`
7. `atel_order_accept`
8. `atel_milestone_submit/verify`
9. `atel_order_timeline`
10. `atel_audit_request_get`

## Release decision rule

Do **not** deploy production MCP until:
- production session contract is stable
- deployment wiring is written down and reproducible
- release smoke commands are executable by an operator without ad hoc fixes
