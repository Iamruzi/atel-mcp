# ATEL MCP Release Candidate on 43

This document defines the 43-only release candidate workflow.
It stays intentionally separate from the 47 production deployment.

## Goal

Use 43 as the public release-candidate host for ATEL MCP until:
- the final public domain is cut over
- the 47 deployment path is ready
- operator verification stays repeatable without ad hoc fixes

## Current verified state

43 now supports two release-candidate modes:

1. `local-test` upstream
   - platform, registry, and relay point to local services on 43
   - used for branch-by-branch smoke and failure-path debugging

2. `production` upstream
   - platform, registry, and relay point to `https://api.atelai.org`
   - used for public remote OAuth verification against the real ATEL environment

Verified on 2026-04-22:
- `https://43-160-230-129.sslip.io/healthz` reports `environment=production`
- public OAuth metadata and protected-resource metadata resolve correctly
- `./scripts/release-verify.sh ./.env.release.production.local` passes full remote OAuth verification

## Runtime shape on 43

- host: `127.0.0.1`
- port: `8787` by default
- process: local Node service
- audit: JSONL written under `.runtime/audit/`
- public host: temporary `sslip.io` hostname until final domain cutover

## Recommended env files

Committed examples:
- `.env.release.example`
  - local-test upstream example for branch smoke and failure debugging
- `.env.release.production.example`
  - production-upstream example for public RC validation

Local operator copies:
- `.env.release.local`
- `.env.release.production.local`

Do not commit the `*.local` files.

## Start / stop

```bash
./scripts/run-release-candidate.sh ./.env.release.local
./scripts/run-release-candidate.sh ./.env.release.production.local
./scripts/stop-release-candidate.sh
```

## Health check

```bash
./scripts/healthcheck.sh ./.env.release.local
./scripts/healthcheck.sh ./.env.release.production.local
```

Quick manual checks:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS https://43-160-230-129.sslip.io/healthz
curl -fsS https://43-160-230-129.sslip.io/.well-known/oauth-authorization-server
curl -fsS https://43-160-230-129.sslip.io/.well-known/oauth-protected-resource/mcp
```

## Verification flow

### Local-test upstream RC

Use the local-test env when validating branch behavior and release smoke:

```bash
./scripts/release-verify.sh ./.env.release.local
```

Default behavior:
- runs the summary verifier
- returns compact JSON with one verdict per branch
- automatically collects diagnostics on failure

Optional:
- `ATEL_MCP_VERIFY_MODE=full ./scripts/release-verify.sh ./.env.release.local`

### Production-upstream RC

Use the production-upstream env when validating the public RC against official ATEL services:

```bash
./scripts/release-verify.sh ./.env.release.production.local
```

When `ATEL_PLATFORM_BASE_URL=https://api.atelai.org`, `release-verify.sh` automatically switches to:
- OAuth client registration
- interactive authorization challenge
- `https://api.atelai.org/auth/v1/verify`
- token exchange
- `initialize`
- `tools/list`
- authenticated `atel_whoami`

## Failure diagnostics

When verification fails, collect diagnostics immediately:

```bash
./scripts/collect-release-diagnostics.sh
```

The bundle includes:
- RC log and tail log
- audit full JSONL and tail JSONL
- release summary payloads when available
- PID snapshot
- `git rev-parse HEAD`
- `git status --short`

## Release discipline

Before every release-debug run on 43:
1. pick the correct env file for the target mode
2. stop the RC process if it is already running
3. start the RC service via `scripts/run-release-candidate.sh`
4. run health check
5. run `release-verify.sh`
6. inspect `.runtime/audit/` when results do not match expectation

## Not included yet

- final domain and TLS cutover
- 47 production deployment and rollback wiring
- old temporary host cleanup after the final domain goes live
