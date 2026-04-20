# ATEL MCP Release Candidate on 43

This document defines the 43-only release candidate workflow.
It is intentionally separate from 47 production deployment.

## Goal

Use 43 as the release-debug host for ATEL MCP until:
- production session contract is finalized
- production deployment wiring is stable
- release smoke is repeatable without manual fixes

## Runtime shape on 43

- host: `127.0.0.1`
- port: `8787` by default
- process: local Node service
- audit: JSONL written under `.runtime/audit/`
- upstream: configurable via env file

## Recommended env file

Start from:
- `.env.release.example`

Typical local/dev release-candidate copy:
- `.env.release.local`

Do not commit `.env.release.local`.

## Start / stop

```bash
./scripts/run-release-candidate.sh ./.env.release.local
./scripts/stop-release-candidate.sh
```

## Health check

```bash
./scripts/healthcheck.sh ./.env.release.local
```

This validates:
- MCP HTTP server is reachable
- `listTools` works
- `atel_whoami` works when bearer token is present

## Full release smoke on 43

```bash
./scripts/release-smoke.sh ./.env.release.local
```

This runs:
1. cleanup
2. MCP HTTP smoke
3. happy-path smoke

If arbitration release smoke is required, run separately:

```bash
ATEL_MCP_ARBITRATION_EXPECTED=passed node dist/dev/smoke-auto-arbitration.js
ATEL_MCP_ARBITRATION_EXPECTED=failed node dist/dev/smoke-auto-arbitration.js
```

## Release discipline

Before every release-debug run on 43:
1. use `smoke:cleanup`
2. start the RC service via `scripts/run-release-candidate.sh`
3. run health check
4. run release smoke
5. inspect audit log under `.runtime/audit/`

## Not included yet

- 47 production deployment
- public reverse-proxy route
- production OAuth rollout
