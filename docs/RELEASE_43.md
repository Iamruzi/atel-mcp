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
4. dispute smoke
5. auto-arbitration passed branch
6. auto-arbitration failed branch

The script performs cleanup and RC restart before each branch so stale dev state does not leak across runs.

## Operator summary view

For a concise release verdict without scanning the full JSON payloads:

```bash
./scripts/release-smoke-summary.sh ./.env.release.local
```

This returns one compact JSON object with:
- one verdict row per branch
- key IDs such as `orderId` and `disputeId`
- final order state per branch
- `artifactsDir` for the preserved full payloads of each branch

## Failure diagnostics

When a release branch fails, collect the现场资料 immediately:

```bash
./scripts/collect-release-diagnostics.sh
```

Optional:
- pass a specific release summary directory as the first argument
- pass a target output directory as the second argument

The diagnostic bundle includes:
- RC full log and tail log
- audit full JSONL and tail JSONL
- latest release summary payloads when available
- PID snapshot
- `git rev-parse HEAD`
- `git status --short`

## Dispute branch expectations

- `atel_dispute_create` returns `status=open`
- `atel_dispute_get` returns the created `disputeId`
- `atel_dispute_list` contains the created dispute
- order audit contains `dispute.created`

## Release discipline

Before every release-debug run on 43:
1. use `smoke:cleanup`
2. start the RC service via `scripts/run-release-candidate.sh`
3. run health check
4. run release smoke
5. inspect audit log under `.runtime/audit/`

## Arbitration branch expectations

- `ATEL_MCP_ARBITRATION_EXPECTED=passed`
  - third reject returns `arbitration_passed`
  - final order remains `executing`
  - `currentMilestone` advances to `1`
  - order audit contains `milestone.arbitration_passed`

- `ATEL_MCP_ARBITRATION_EXPECTED=failed`
  - third reject returns `arbitration_failed`
  - final order becomes `cancelled`
  - timeline contains `order.cancelled`
  - order audit contains `milestone.arbitration_failed`

## Not included yet

- 47 production deployment
- public reverse-proxy route
- production OAuth rollout
