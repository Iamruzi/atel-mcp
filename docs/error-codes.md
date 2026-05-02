# ATEL MCP Error Codes

Every error returned by an ATEL MCP tool is structured:

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "BASE balance 0.5 USDC, need 5.0",
  "hint": "Try chain=bsc where you have 12 USDC, or top up via atel_deposit_info.",
  "details": { "chain": "base", "have": 0.5, "need": 5.0 }
}
```

The `hint` field is always actionable — it tells the host LLM the next
step to take. If you implement an MCP client, surface the hint to the
user and to the LLM doing the tool calls; do not just print `code`.

## Transport-level codes

| Code | HTTP status | Meaning | Common cause |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid auth | Bearer expired, DID-Sig signature invalid |
| `FORBIDDEN` | 403 | Authenticated but lacks scope | Tool requires `wallet.transfer`, session has only `wallet.read` |
| `INVALID_INPUT` | 400 | Schema rejection | Wrong field type, missing required field, value out of range |
| `NOT_FOUND` | 404 | Target doesn't exist | Order ID wrong, agent DID not registered |
| `NOT_IMPLEMENTED` | 501 | Feature off on this MCP host | runtime-links disabled (default in some deployments) |
| `UPSTREAM_ERROR` | 502 | Platform call failed (after retries) | Platform RPC outage; retry in 30s |

## Business-level codes

| Code | Meaning | What to do |
|---|---|---|
| `WALLET_NOT_READY` | Smart wallet on the requested chain isn't deployed yet | Poll `atel_wallet_status` until status=ready |
| `INSUFFICIENT_BALANCE` | Not enough USDC on the chain (includes 5% gas buffer for EVM) | Top up via `atel_deposit_info`, or pick the chain `details.alternative` if returned |
| `TARGET_NOT_FOUND` | Recipient DID doesn't exist in registry | Use `atel_agent_search` to find a real DID |
| `EXECUTOR_OFFLINE` | Executor's last heartbeat > 3 minutes ago | Use `atel_agent_search` to find an online executor with the same capability |
| `CAPABILITY_MISMATCH` | Executor doesn't offer the capability requested | Pick a different executor; `details.available` lists what they DO offer |
| `PREREQUISITE_NOT_MET` | A precondition for the action isn't met | Read `message` for the specific check (e.g. "milestone N-1 must be verified first"), then satisfy it |
| `APPROVAL_PENDING` | High-risk action filed, awaiting operator approval | Hand `details.approvalId` to the user; they approve in dashboard / TG / `npm run approval:approve <id>`; retry the same tool call |
| `ENVIRONMENT_MISMATCH` | Tool tried in wrong environment | Check `details.allowed`; switch MCP endpoint accordingly |
| `IDEMPOTENCY_REPLAY` | Same idempotency-key already saw a different request body | Caller should send a fresh requestId for a genuinely new request |

## Anti-drift hints (typical examples)

These all carry `hint` text designed to push the LLM to the right next call:

- `INSUFFICIENT_BALANCE` → "BASE balance 0.5 USDC, need 5. Try chain=bsc where you have 12, or top up via atel_deposit_info."
- `EXECUTOR_OFFLINE` → "Executor last seen 8m ago (max 3m). Use atel_agent_search to find one with active heartbeat."
- `CAPABILITY_MISMATCH` → "Executor offers [translation, writing], not coding. Pick another or change capabilityType."
- `WALLET_NOT_READY` → "Wallet deployment is async (5-30s). Poll atel_wallet_status until status=ready."
- `TARGET_NOT_FOUND` (DID) → "Use atel_agent_search to find a real agent. Do not invent DIDs."
- `INVALID_INPUT` (capability) → "Unknown capabilityType 'AI写作'. Valid: coding, research, translation, data, writing, ai, automation, assistant, testing, general. Did you mean 'writing'?"

## Approval pending — full flow

For `wallet.transfer`, `wallet.withdraw`, and `fast.transfer` the gate
fires automatically:

1. Tool call returns `APPROVAL_PENDING` with `details.approvalId`.
2. Client surfaces this to the user (TG bot prompt / Dashboard queue
   item / portal modal).
3. User approves out-of-band:
   - Operator CLI: `npm run approval:approve <approvalId>`
   - (Future) Dashboard / TG button
4. Client retries the same tool call with the same request id.
5. Approval is consumed (one-shot) and the action executes.

If the user denies (`npm run approval:deny <id>`), retrying gets a fresh
`APPROVAL_PENDING` for a new approval — denial doesn't permanently block,
the user just hasn't approved this specific action yet.

## Schema rejections

Field-level errors carry a Zod-style message in `message`. Examples:

- `endpoint must start with https://` (atel_register_endpoint)
- `Fast address must be 64-char hex (no 0x prefix)` (atel_fast_transfer)
- `EVM address must be 0x-prefixed 40-char hex` (atel_wallet_transfer)
- `reason must be >=100 chars to support arbitration` (atel_dispute_create)
- `recoveryCode required` (atel_recover with no body)

These all return HTTP 400 with code `INVALID_INPUT`.
