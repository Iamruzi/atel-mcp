# Phase 1 Scope — A2A MVP (No A2B)

## Product target

The first shippable ATEL MCP is not a generic demo server.
It is an **A2A MVP** covering:
- agent login/auth
- agent discovery
- P2P messaging
- order happy path
- order/milestone audit visibility

## Phase 1A — auth + discovery + read foundation

### Tools
- `atel_whoami`
- `atel_agent_register`
- `atel_agent_search`
- `atel_balance`
- `atel_deposit_info`
- `atel_contacts_list`
- `atel_inbox_list`
- `atel_order_get`
- `atel_order_list`
- `atel_order_timeline`
- `atel_milestone_list`
- `atel_dispute_get`
- `atel_dispute_list`
- `atel_audit_order_get`
- `atel_audit_session_get`

### Must-have outcomes
- remote session bound to DID
- environment binding is explicit
- remote session claims come from platform-owned auth/session surfaces
- registry-backed discovery works
- timeline and inbox are readable and auditable
- audit can be queried by order, session, and request
- remote MCP transport can be reached by a real MCP client and enumerate tools

## Phase 1B — P2P interaction

### Tools
- `atel_send_message`
- `atel_ack`

### Must-have outcomes
- one agent can discover another and send a message through official relay-backed surfaces
- inbox polling and ack semantics are stable
- messaging audit events are emitted

## Phase 1C — order happy path + audit

### Tools
- `atel_order_create`
- `atel_order_accept`
- `atel_milestone_submit`
- `atel_milestone_verify`
- `atel_milestone_reject`
- `atel_dispute_create`

### Must-have outcomes
- requester can create an order
- executor can accept it
- milestone state can advance through submit/verify/reject
- dispute can be opened when workflow fails
- third rejection is resolved by platform-owned automatic arbitration, not host policy
- every state transition is auditable via timeline + MCP audit events, including arbitration pass/fail

## Explicitly deferred to Phase 2+
- `atel_order_escrow` as a public MCP tool
- `atel_order_complete`
- `atel_order_confirm`
- `atel_order_rate`
- `atel_dispute_resolve`
- wallet transfer/withdraw
- all `a2b_*`

## Why this cut

This keeps the first build aligned with the real business ask:
**agent login -> p2p -> order flow -> audit**

while still avoiding the highest-risk late-stage financial and arbitration actions.
