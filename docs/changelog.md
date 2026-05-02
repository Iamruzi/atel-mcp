# ATEL MCP Changelog

## v0.2.0 — 2026-05-02 (production hardening)

Major reliability + onboarding pass. ~30 commits across atel-mcp +
atel-platform + openclaw-plugin.

### New tools (12 added → 41 total)

Onboarding:
- `atel_register_user` — pre-auth, mints fresh identity in one call
- `atel_recover` — pre-auth, look up DID by recovery code
- `atel_wallet_status` — poll AutoWallet deployment progress
- `atel_register_endpoint` — advertise callback URL with reachability check

Anti-drift:
- `atel_a2b_quote` — server-side USDC pricing (stops "LLM uses training-
  data exchange rate" failure mode)

A2B writes:
- `atel_a2b_intent_create`, `atel_a2b_lock_funds`, `atel_a2b_execute_purchase`

Fast Network:
- `atel_fast_balance`, `atel_fast_deposit_address`, `atel_fast_transfer`

High-risk wallet:
- `atel_wallet_transfer` (EVM internal P2P, approval-gated)
- `atel_wallet_withdraw` (external, approval-gated on every amount)

Arbitration:
- `atel_dispute_resolve` (Platform DID arbitrator action)

Approval queue:
- `atel_approval_list`, `atel_approval_get`

### Reliability layer (cross-cuts every tool)

- **Schema enforcement** (Zod) — every tool input validated, drift caught
  before any platform call
- **Prerequisite checks** (`src/auth/prerequisites.ts`):
  - `walletReady(chain)` — smart wallet deployed
  - `sufficientBalance(chain, amount)` — incl. 5% gas buffer for EVM
  - `targetExists(did)` — recipient agent in registry
  - `executorReady(did, capability)` — online + capability match
  - `orderInStatus(orderId, allowed[])` — state-machine enforcement
  - `callerIsRole(orderId, requester|executor)` — role check
  - `previousMilestoneVerified(orderId, index)` — sequential milestones
  - `milestoneIsSubmitted(orderId, index)` — verify/reject preconditions
  - `disputeRejectThresholdMet(orderId, threshold=3)` — stops noise disputes
- **Approval gate** (`src/approval/`) — high-risk fund movement requires
  out-of-band per-action operator approval. CLI: `npm run approval:approve <id>`.
- **Actionable error hints** — every error includes a `hint` field with
  the next step the LLM should take (see `docs/error-codes.md`).
- **Idempotency-key** auto-injected on every MCP→platform POST
- **Retry with exponential backoff** on 5xx / 429 / network errors (3 attempts)
- **Per-DID rate limit** (token bucket, 60 capacity / 10/sec refill)
- **Audit dual-write** to JSONL primary + platform `mcp_audit_log` (best-effort secondary)

### Auth

- **DID-Sig** auth scheme added (`Authorization: ATEL-DID-Sig <base64>`)
  for headless agents. Pairs with platform `POST /auth/v1/did-sig`.
- OAuth flow unchanged.

### Observability

- `GET /metrics` — Prometheus exposition
- Counters: `atel_mcp_tool_calls_total`, `atel_mcp_dispatch_total`,
  `atel_mcp_platform_request_total`
- Histogram: `atel_mcp_tool_duration_ms`

### OpenClaw plugin (`atel-mcp-openclaw` 0.1.3 → 0.2.0)

**BREAKING CHANGE**. Removed `LOCAL_SIGNED_TOOLS` bypass. All 5 critical
tools (order_create / order_accept / milestone_submit / milestone_verify
/ dispute_create) now route through MCP server, gaining the full
anti-drift stack. Auth changed from OAuth dance → single DID-Sig
exchange.

Migration:
```bash
npm i atel-mcp-openclaw@0.2.0  # or npx -y atel-mcp-openclaw
```
Old OAuth cache (`~/.openclaw/atel-mcp-oauth-cache.json`) safe to delete;
new cache at `~/.openclaw/atel-mcp-did-sig-cache.json`.

### atel-platform (cross-repo)

- `POST /auth/v1/register` — generates ed25519 keypair + DID + AutoWallet
- `POST /auth/v1/recovery` — DID lookup by recovery code (hash-only storage)
- `POST /auth/v1/did-sig` — exchanges signed envelope for JWT bearer
- `POST /audit/v1/mcp/ingest` — receives MCP audit dual-write
- `POST /registry/v1/remote/endpoint` — registers callback URL with
  HEAD reachability check
- `GET /capability/v1/standard` — canonical capability registry
- `POST /dispute/v1/{id}/resolve` — arbitration action
- `handleCreateOrder` now enforces walletReady + sufficientBalance +
  executor online (closes the OpenClaw plugin LOCAL_SIGNED_TOOLS bypass
  bottom-up — any input path now hits the same checks)

### Test coverage

176 atel-mcp tests + ~40 new platform tests. Anti-drift suite
(`src/tests/anti-drift.test.ts`) pins 18 mock-LLM-error scenarios with
actionable-hint assertions.

### Known limitations (deferred)

- **OAuth still uses Platform Challenge-Response, not standard PKCE.**
  External hosts can read our code; cleaner standard PKCE migration is
  tracked but not in v0.2.
- **No KEK-encrypted secretKey backup.** `atel_recover` returns DID
  only — lost secretKey is permanently lost. KEK custody is a separate
  security model and security-review effort.
- **runtime-links subsystem retained but unused.** Default `true` for
  back-compat; production-relevance unverified. Schedule a cleanup once
  OpenClaw migration finishes (no consumer expected post-v0.2).
- **Approval queue UI** lives in CLI only (`npm run approval:approve <id>`).
  Portal Dashboard integration is queued but not in this release.
- **atel-platform server-side heartbeat cron** not implemented; agents
  still self-heartbeat via SDK.

### Files of interest

- `src/contracts/errors.ts` — error code enum + AtelMcpError shape
- `src/auth/prerequisites.ts` — every prereq check
- `src/approval/{store,gate}.ts` — approval system
- `src/server/metrics.ts` — Prometheus exposition
- `src/server/pre-auth.ts` — pre-auth tool registry (security-sensitive)
- `docs/error-codes.md` — full error table
- `docs/scope-matrix.md` — scope ↔ tool ↔ tier
- `docs/happy-path-example.md` — end-to-end walk-through

## v0.1.0 — 2026-04-25 (initial)

28 tools, OAuth Platform Challenge-Response, Streamable HTTP transport,
Zod schemas, JSONL audit, runtime-links. Bootstrap implementation.
