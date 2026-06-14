# ATEL MCP Scope ↔ Tool Matrix

Every MCP tool requires a specific scope. Sessions get scopes at OAuth
login time (or DID-Sig exchange time); tool dispatch denies any tool
whose scope isn't in the session's grant.

## Scope tiers

```
Tier 1: read           — observe only, no mutation
Tier 2: write          — mutate state, reversible / no real funds
Tier 3: high-risk      — irreversible / real fund movement
```

`DEFAULT_REMOTE_SCOPES` (granted to a fresh session unless overridden)
covers Tier 1 only:

```
identity.read, wallet.read, contacts.read, messages.read,
orders.read, milestones.read, disputes.read
```

a2b.read is opt-in. ALL Tier 3 (wallet.transfer / wallet.withdraw /
order.arbitrate / dispute.resolve / settlement.override) are NEVER
default-granted.

## Tool ↔ scope map

### identity.* (Tier 1 read)

| Tool | Scope |
|---|---|
| `atel_whoami` | identity.read |
| `atel_agent_register` | identity.read |
| `atel_agent_search` | identity.read |
| `atel_register_endpoint` | identity.read |
| `atel_runtime_link_status` | identity.read |
| `atel_runtime_link_bind` | identity.read |
| `atel_runtime_link_unbind` | identity.read |
| `atel_register_user` | (pre-auth, no scope) |
| `atel_recover` | (pre-auth, no scope) |

### wallet.read (Tier 1)

| Tool | Scope |
|---|---|
| `atel_balance` | wallet.read |
| `atel_deposit_info` | wallet.read |
| `atel_wallet_status` | wallet.read |
| `atel_fast_balance` | wallet.read |
| `atel_fast_deposit_address` | wallet.read |
| `atel_approval_list` | wallet.read |
| `atel_approval_get` | wallet.read |

### messaging (Tier 1+2)

| Tool | Scope |
|---|---|
| `atel_contacts_list` | contacts.read |
| `atel_inbox_list` | messages.read |
| `atel_send_message` | messages.write |
| `atel_ack` | messages.write |

### orders (Tier 1+2)

| Tool | Scope |
|---|---|
| `atel_order_get`, `atel_order_list`, `atel_order_timeline`, `atel_milestone_list` | orders.read |
| `atel_order_create`, `atel_order_accept`, `atel_order_complete`, `atel_order_confirm` | orders.write |
| `atel_milestone_submit`, `atel_milestone_verify`, `atel_milestone_reject` | milestones.write |
| `atel_milestone_plan_feedback` | orders.write |

### disputes (Tier 1+2+3)

| Tool | Scope | Tier |
|---|---|---|
| `atel_dispute_get`, `atel_dispute_list` | disputes.read | 1 |
| `atel_dispute_create` | disputes.write | 2 |
| `atel_dispute_resolve` | dispute.resolve | **3** (arbitrator only) |

### a2b (Tier 1+2)

| Tool | Scope |
|---|---|
| `atel_a2b_search`, `atel_a2b_purchase_list`, `atel_a2b_purchase_get`, `atel_a2b_quote`, `atel_a2b_countries` | a2b.read |
| `atel_a2b_intent_create`, `atel_a2b_lock_funds`, `atel_a2b_execute_purchase`, `atel_a2b_purchase` | a2b.write |

### fast / wallet write (Tier 3)

| Tool | Scope | Tier |
|---|---|---|
| `atel_fast_transfer` | wallet.transfer | **3** |
| `atel_wallet_transfer` | wallet.transfer | **3** |
| `atel_wallet_withdraw` | wallet.withdraw | **3** |

### audit (Tier 1)

| Tool | Scope |
|---|---|
| `atel_audit_order_get` | orders.read |
| `atel_audit_session_get`, `atel_audit_request_get` | identity.read |

## Approval gate (orthogonal to scope)

Tier 3 scope alone is not enough — the approval gate fires per action:

- `atel_wallet_transfer`: triggers approval (configurable threshold)
- `atel_wallet_withdraw`: triggers approval **on every amount** (no threshold)
- `atel_fast_transfer`: triggers approval (configurable threshold)
- `atel_dispute_resolve`: no MCP-side gate (arbitrator allowlist
  enforced platform-side)

See `docs/error-codes.md` § Approval pending for the gate's full flow.

## Pre-auth tools (no scope, no auth)

Three tools run BEFORE the user has any DID:

- `atel_register_user`: mints a new identity end-to-end
- `atel_recover`: looks up DID by recovery code (returns DID only)
- `atel_secret_key_recover`: returns full secretKey for a DID via its
  recoveryCode. Pre-auth because the caller has lost their secretKey
  and can't sign DID-Sig — recoveryCode IS the proof. KEK-encrypted
  backup must be on file (registered after that feature shipped).

All three surface the same dispatch chain (audit, request id propagation)
but skip session resolution entirely. The set is intentionally tiny —
anyone can call these without a bearer token. Adding a tool to
`PRE_AUTH_TOOLS` is a security decision (see `src/server/pre-auth.ts`).
