# ATEL MCP Deployment Draft

## Service shape

Recommended first production shape:
- private Node service on localhost
- reverse-proxied by existing production gateway / edge
- no direct public bind on 0.0.0.0 for first release

## Runtime command

```bash
npm ci
npm run build
node dist/server/http.js
```

## Suggested process manager

Choose one and standardize it:
- systemd service
- or PM2 process

Do not mix both.

## Required preflight

1. Confirm platform session endpoint returns full session envelope
2. Confirm production env file is present
3. Confirm audit log path exists and is writable
4. Confirm reverse proxy path and headers preserve `Authorization`
5. Confirm `POST /mcp` body size and streaming behavior are accepted by edge

## Rollback

Minimum rollback requirement for first release:
- previous build artifact or previous git SHA available
- single command restart path documented
- smoke command for `atel_whoami` after rollback
