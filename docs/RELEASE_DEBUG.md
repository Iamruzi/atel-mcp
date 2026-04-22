# ATEL MCP Release Debug Status

## Current status

The ATEL MCP release-candidate path is now split into two verified modes on 43:

### 1. Local-test upstream

Used for branch-level release smoke and failure-path debugging.

Verified coverage:
- bearer auth/session resolution
- agent register/search
- P2P send/inbox/ack
- order happy path
- dispute branch
- reject x3 -> arbitration passed
- reject x3 -> arbitration failed
- audit write + read
- cleanup discipline
- environment mismatch guard

### 2. Production upstream

Used for real public remote MCP verification against the official ATEL environment.

Verified coverage:
- public health endpoint
- OAuth authorization-server metadata
- OAuth protected-resource metadata
- client registration
- interactive authorization challenge
- platform verify through `https://api.atelai.org/auth/v1/verify`
- token exchange
- `initialize`
- `tools/list`
- authenticated `atel_whoami`

## Resolved release blockers

### R1. Auth/session contract is good enough for this release slice

Current MCP runtime uses:
- `GET /auth/v1/session`
- fallback `GET /auth/v1/me`

Release position:
- current contract is sufficient for the present Remote MCP release-candidate path
- fallback still exists for compatibility, but the release path is no longer blocked on session resolution

### R2. 43 deployment wiring exists and is repeatable

Current operator flow includes:
- `scripts/run-release-candidate.sh`
- `scripts/stop-release-candidate.sh`
- `scripts/healthcheck.sh`
- `scripts/release-verify.sh`
- `scripts/collect-release-diagnostics.sh`
- committed env examples for both local-test and production-upstream RC modes

### R3. Operator docs exist

Release guidance now exists in:
- `docs/RELEASE_43.md`
- `docs/DOMAIN_CUTOVER.md`
- client docs under `docs/clients/`

## Remaining release blockers

### B1. Final public domain is not cut over yet

Current public RC host is still:
- `https://43-160-230-129.sslip.io`

Release is not fully closed until:
- owned domain is live
- TLS is finalized on that host
- OAuth metadata advertises the final domain
- user docs point to the final example host

### B2. 47 production deployment path is not the active MCP path yet

Current Remote MCP public RC runs on 43.

If ATEL MCP is meant to move to 47, the remaining work is:
- define systemd service ownership
- define reverse proxy ownership
- document rollback
- re-run the public OAuth verification on 47

## Release decision

Current decision:
- ATEL MCP is functionally complete for the current release slice
- 43 is a valid public release-candidate host
- production-upstream remote OAuth is verified
- the remaining work is final domain cutover and, if desired, 47 deployment

That means the service is no longer blocked on feature completeness.
It is now in final release-hardening and cutover stage.
